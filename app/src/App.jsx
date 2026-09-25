import { useCallback, useEffect, useRef, useState } from 'react';
import { LEAGUE_NAMES, PLAYERS } from './data.js';
import { LS, load, save } from './lib/store.js';
import { SEASON, WEEKS, currentWeek, seedWeek } from './lib/season.js';
import { mkPlayer } from './lib/teams.js';
import { groupByGame } from './lib/games.js';
import { matchSleeperLeague, sleeperLeagues, syncSleeper } from './lib/sleeper.js';
import { syncEspn } from './lib/espn.js';

const DEFAULT_USER = 'Uncutgems82';
const DEFAULT_CONN = {
  RDL: { source: 'sleeper' },
  DFL: { source: 'sleeper' },
  Deloitte: { source: 'espn', leagueId: '308619009', teamId: '1' }
};
const SRC_NAME = { sleeper: 'Sleeper', espn: 'ESPN', manual: 'By hand' };
const RESYNC_MS = 15 * 60000;

// The built-in connections apply unless a league has been linked to something else.
function mergeConn(saved) {
  const out = {};
  LEAGUE_NAMES.forEach(n => {
    const s = saved[n];
    out[n] = s && s.source !== 'manual' && (s.leagueId || s.source === 'sleeper') ? s : { ...DEFAULT_CONN[n] };
  });
  return out;
}

const isLinked = c => !!c && c.source !== 'manual' && !!(c.leagueId || c.source === 'sleeper');

function initialDb() {
  const s = load(LS, null) || {};
  const week = currentWeek();
  const data = s.data || {};
  if (!data[week]) data[week] = seedWeek(week, data);
  return {
    week, data,
    scored: s.scored || {},
    conn: mergeConn(s.conn || {}),
    sleeperUser: s.sleeperUser || DEFAULT_USER,
    synced: s.synced || {}
  };
}

export default function App() {
  // Saved on the device: lineups per week, crossed-off players, connections, sync results.
  const [db, setDb] = useState(initialDb);
  const dbRef = useRef(db);
  dbRef.current = db;
  useEffect(() => { save(LS, db); }, [db]);

  const [screen, setScreen] = useState('games');
  const [filter, setFilter] = useState('all');
  const [editFor, setEditFor] = useState(null);
  const [connFor, setConnFor] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState('');
  const syncingRef = useRef(false);
  const toastTimer = useRef(0);

  const flash = useCallback(msg => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2600);
  }, []);

  const setLeague = useCallback((week, league, lineup, how) => {
    setDb(prev => {
      const data = { ...prev.data };
      const wk = { ...(data[week] || seedWeek(week, data)) };
      wk[league] = { mine: lineup.mine.map(mkPlayer), opp: lineup.opp.map(mkPlayer), how, at: Date.now() };
      data[week] = wk;
      return { ...prev, data };
    });
  }, []);

  const editLeague = useCallback((league, fn) => {
    setDb(prev => {
      const data = { ...prev.data };
      const wk = { ...(data[prev.week] || seedWeek(prev.week, data)) };
      const l = { mine: [...wk[league].mine], opp: [...wk[league].opp] };
      fn(l);
      wk[league] = { ...l, how: 'manual', at: Date.now() };
      data[prev.week] = wk;
      return { ...prev, data };
    });
  }, []);

  const setConn = useCallback((league, patch) => {
    setDb(prev => ({ ...prev, conn: { ...prev.conn, [league]: { source: 'manual', ...(prev.conn[league] || {}), ...patch } } }));
  }, []);

  const markSynced = useCallback((key, result) => {
    setDb(prev => ({ ...prev, synced: { ...prev.synced, [key]: { at: Date.now(), ...result } } }));
  }, []);

  // Pulls one league's starters for a week from its connection.
  const pullLeague = useCallback(async (league, week) => {
    const { conn, sleeperUser } = dbRef.current;
    const c = conn[league];
    if (c.source === 'sleeper') {
      let leagueId = c.leagueId;
      if (!leagueId) {
        const taken = LEAGUE_NAMES.filter(n => n !== league && conn[n] && conn[n].source === 'sleeper' && conn[n].leagueId).map(n => conn[n].leagueId);
        const hit = await matchSleeperLeague(sleeperUser, league, taken);
        setConn(league, hit);
        leagueId = hit.leagueId;
      }
      return syncSleeper(sleeperUser, leagueId, week);
    }
    return syncEspn(c.leagueId, c.teamId, week);
  }, [setConn]);

  const syncOne = useCallback(async (league, week) => {
    const source = dbRef.current.conn[league].source;
    try {
      const res = await pullLeague(league, week);
      setLeague(week, league, res, source);
      markSynced(league + ':' + week, { ok: true });
      return true;
    } catch (e) {
      markSynced(league + ':' + week, { ok: false, err: e.message });
      return false;
    }
  }, [pullLeague, setLeague, markSynced]);

  // auto: only leagues not synced in the last 15 minutes, and stay quiet unless something failed.
  const syncAll = useCallback(async (auto) => {
    if (syncingRef.current) return;
    const { conn, synced, week } = dbRef.current;
    const targets = LEAGUE_NAMES.filter(n => {
      if (!isLinked(conn[n])) return false;
      if (!auto) return true;
      const s = synced[n + ':' + week];
      return !s || !s.ok || Date.now() - s.at > RESYNC_MS;
    });
    if (!targets.length) {
      if (!auto) flash('No connected leagues yet — tap Connect on a league.');
      return;
    }
    syncingRef.current = true;
    setSyncing(true);
    let ok = 0;
    for (const n of targets) if (await syncOne(n, week)) ok++;
    syncingRef.current = false;
    setSyncing(false);
    if (!auto || ok < targets.length) flash('Synced ' + ok + ' of ' + targets.length + ' connected leagues');
  }, [syncOne, flash]);

  // Refresh when the app opens, when the week changes, and when it comes back to the foreground.
  useEffect(() => { syncAll(true); }, [db.week, syncAll]);
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') syncAll(true); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [syncAll]);

  const setWeek = w => setDb(prev => {
    const data = prev.data[w] ? prev.data : { ...prev.data, [w]: seedWeek(w, prev.data) };
    return { ...prev, week: w, data };
  });

  const toggleScored = uid => setDb(prev => {
    const ws = { ...(prev.scored[prev.week] || {}) };
    ws[uid] = !ws[uid];
    return { ...prev, scored: { ...prev.scored, [prev.week]: ws } };
  });

  const closeConn = () => { setConnFor(null); syncAll(true); };

  const { week } = db;
  const wk = db.data[week] || {};

  return (
    <div className="app">
      <header className="head">
        <div className="title-row">
          <h1 className="title">{screen === 'games' ? 'Week ' + week : 'Leagues'}</h1>
          <button className="link-action sync" disabled={syncing} onClick={() => syncAll(false)}>{syncing ? 'Syncing…' : 'Sync'}</button>
        </div>
        <WeekChips week={week} onPick={setWeek} />
      </header>

      <main className="body sc">
        {screen === 'games'
          ? <Games week={week} wk={wk} scored={db.scored[week] || {}} filter={filter} setFilter={setFilter} onToggle={toggleScored} />
          : <Leagues week={week} wk={wk} conn={db.conn} synced={db.synced} syncing={syncing}
              onSync={async n => { if (await syncOne(n, week)) flash(n + ' synced'); }}
              onEdit={setEditFor} onConnect={setConnFor} />}
      </main>

      <nav className="tabs">
        <button className={screen === 'games' ? 'on' : ''} onClick={() => setScreen('games')}>By game</button>
        <button className={screen === 'leagues' ? 'on' : ''} onClick={() => setScreen('leagues')}>Leagues</button>
      </nav>

      {editFor && <EditSheet league={editFor} week={week} lineup={wk[editFor] || { mine: [], opp: [] }}
        onEdit={fn => editLeague(editFor, fn)} onClose={() => setEditFor(null)} />}

      {connFor && <ConnectSheet league={connFor} week={week} conn={db.conn[connFor] || { source: 'manual' }}
        sleeperUser={db.sleeperUser} setSleeperUser={u => setDb(prev => ({ ...prev, sleeperUser: u }))}
        setConn={patch => setConn(connFor, patch)}
        syncErr={(db.synced[connFor + ':' + week] || {}).err}
        takenIds={LEAGUE_NAMES.filter(n => n !== connFor && db.conn[n] && db.conn[n].source === 'sleeper').map(n => db.conn[n].leagueId).filter(Boolean)}
        testEspn={async c => { const res = await syncEspn(c.leagueId, c.teamId, week); setLeague(week, connFor, res, 'espn'); markSynced(connFor + ':' + week, { ok: true }); return res; }}
        onClose={closeConn} />}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function WeekChips({ week, onPick }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current && ref.current.querySelector('.on');
    if (el) el.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [week]);
  const chips = [];
  for (let w = 1; w <= WEEKS; w++) {
    chips.push(<button key={w} className={'chip' + (w === week ? ' on' : '')} onClick={() => onPick(w)}>W{w}</button>);
  }
  return <div className="weeks sc" ref={ref}>{chips}</div>;
}

function Games({ week, wk, scored, filter, setFilter, onToggle }) {
  const { games, bye } = groupByGame(week, wk);
  const shown = games.filter(g => filter === 'all' || g.mine.length);
  if (filter === 'all' && (bye.mine.length || bye.theirs.length)) {
    shown.push({ key: 'bye', title: 'Bye or unmatched', time: 'No game found for these teams in week ' + week, status: 'Check', ...bye });
  }
  const yours = shown.reduce((s, g) => s + g.mine.length, 0);
  const against = shown.reduce((s, g) => s + g.theirs.length, 0);

  const player = p => (
    <button key={p.uid} className={'pl' + (scored[p.uid] ? ' done' : '')} onClick={() => onToggle(p.uid)}>
      <div className="pl-name">{p.name}{p.leagues.length > 1 ? '  ×' + p.leagues.length : ''}</div>
      <div className="pl-meta">{[p.pos, p.team, p.leagues.join(' · ')].filter(Boolean).join(' · ')}</div>
    </button>
  );

  return (
    <div>
      <div className="stats">
        <div className="stat"><div className="stat-n">{shown.length}</div><div className="stat-l">Games</div></div>
        <div className="stat"><div className="stat-n">{yours}</div><div className="stat-l">Yours</div></div>
        <div className="stat"><div className="stat-n accent">{against}</div><div className="stat-l">Against</div></div>
      </div>
      <div className="seg2">
        <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All games</button>
        <button className={filter === 'mine' ? 'on' : ''} onClick={() => setFilter('mine')}>Only mine</button>
      </div>
      {shown.map(g => (
        <section key={g.key} className="game">
          <div className="game-head">
            <div className="game-title">{g.title}</div>
            <div className={'badge' + (g.status === 'Live' ? ' hot' : '')}>{g.status}</div>
          </div>
          <div className="game-time">{g.time}</div>
          <div className="sides">
            <div className="side-mine">
              <div className="side-h">You have</div>
              {g.mine.map(player)}
              {!g.mine.length && <div className="side-empty">—</div>}
            </div>
            <div className="side-theirs">
              <div className="side-h">They have</div>
              {g.theirs.map(player)}
              {!g.theirs.length && <div className="side-empty">—</div>}
            </div>
          </div>
        </section>
      ))}
      <div className="foot">
        {shown.length ? 'Tap a player to cross them off once they\'ve played.' : 'No lineups for week ' + week + ' yet. Connect a league or edit it by hand.'}
      </div>
    </div>
  );
}

function Leagues({ week, wk, conn, synced, syncing, onSync, onEdit, onConnect }) {
  return (
    <div>
      {LEAGUE_NAMES.map(n => {
        const l = wk[n] || { mine: [], opp: [] };
        const c = conn[n] || { source: 'manual' };
        const sy = synced[n + ':' + week];
        const linked = isLinked(c);
        let status = l.how === 'manual' ? 'Edited by hand' : l.how ? 'Pulled from ' + SRC_NAME[l.how] : 'Carried over — not updated for week ' + week;
        if (l.at) status += ' · ' + new Date(l.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
        const failed = sy && !sy.ok && !(l.at > sy.at);
        return (
          <section key={n} className="league">
            <div className="league-head">
              <div className="league-name">{n}</div>
              <div className={'badge' + (linked ? ' hot' : '')}>{linked ? SRC_NAME[c.source] : 'Manual'}</div>
              <div className="league-counts">{l.mine.length} v {l.opp.length}</div>
            </div>
            <div className={'league-status' + (failed ? ' err' : '')}>{failed ? sy.err : status}</div>
            <div className="actions">
              {linked
                ? <button className="btn btn-primary" disabled={syncing} onClick={() => onSync(n)}>Sync</button>
                : null}
              <button className={'btn' + (linked ? '' : ' btn-primary')} onClick={() => onEdit(n)}>Edit</button>
              <button className="btn" onClick={() => onConnect(n)}>Connect</button>
            </div>
          </section>
        );
      })}
      <div className="foot">Each week is saved on this device. Connected leagues refresh automatically when you open the app; the rest you update by hand.</div>
    </div>
  );
}

function EditSheet({ league, week, lineup, onEdit, onClose }) {
  const [side, setSide] = useState('mine');
  const [query, setQuery] = useState('');
  const list = lineup[side] || [];
  const q = query.trim().toLowerCase();
  const results = q.length < 2 ? [] : PLAYERS.filter(p => p.n.toLowerCase().includes(q)).slice(0, 6);

  return (
    <div className="sheet" role="dialog" aria-label={'Edit ' + league}>
      <div className="sheet-head">
        <div className="title-row">
          <h2 className="title">{league}</h2>
          <button className="link-action" onClick={onClose}>Done</button>
        </div>
        <div className="subtitle">Week {week} · {list.length} players</div>
      </div>
      <div className="sheet-body sc">
        <div className="seg2 tall">
          <button className={side === 'mine' ? 'on' : ''} onClick={() => setSide('mine')}>Your starters</button>
          <button className={side === 'opp' ? 'on red' : ''} onClick={() => setSide('opp')}>Opponent</button>
        </div>
        {list.map(p => (
          <div key={p.id} className="row">
            <div className="row-pos">{p.pos}</div>
            <div className="row-name">{p.name}</div>
            <div className="row-team">{p.team}</div>
            <button className="x" aria-label={'Remove ' + p.name} onClick={() => onEdit(l => { l[side] = l[side].filter(x => x.id !== p.id); })}>×</button>
          </div>
        ))}
        <div style={{ padding: '16px 18px 30px' }}>
          <input className="input" value={query} onChange={e => setQuery(e.target.value)} placeholder="Add a player by name" autoComplete="off" autoCorrect="off" />
          {results.map(p => (
            <button key={p.n + p.t} className="result" onClick={() => { onEdit(l => { l[side] = [...l[side], mkPlayer(p)]; }); setQuery(''); }}>
              <span className="result-name">{p.n}</span>
              <span className="result-meta">{p.p} · {p.t}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ConnectSheet({ league, week, conn, sleeperUser, setSleeperUser, setConn, syncErr, takenIds, testEspn, onClose }) {
  const [sleeperList, setSleeperList] = useState(null);
  const [sleeperMsg, setSleeperMsg] = useState('');
  const [espnMsg, setEspnMsg] = useState('');
  const c = conn;

  const findSleeper = async () => {
    setSleeperMsg('Looking up leagues…');
    setSleeperList(null);
    try {
      const list = await sleeperLeagues(sleeperUser);
      setSleeperList(list);
      setSleeperMsg(list.length ? 'Tap your ' + league + ' league.' : 'No ' + SEASON + ' leagues on that account.');
    } catch (e) { setSleeperMsg(e.message); }
  };

  // List the account's leagues straight away so picking one is a single tap.
  useEffect(() => { if (c.source === 'sleeper') findSleeper(); }, [c.source]); // eslint-disable-line react-hooks/exhaustive-deps

  const runEspn = async () => {
    if (!c.leagueId || !c.teamId) { setEspnMsg('Enter both IDs.'); return; }
    setEspnMsg('Connecting…');
    try {
      const res = await testEspn(c);
      setEspnMsg('Connected — pulled ' + res.mine.length + ' + ' + res.opp.length + ' starters.');
    } catch (e) { setEspnMsg(e.message); }
  };

  const pickSource = s => setConn({ source: s, leagueId: s === c.source ? c.leagueId : '', teamId: s === c.source ? c.teamId : '' });

  return (
    <div className="sheet" role="dialog" aria-label={'Connect ' + league} style={{ zIndex: 85 }}>
      <div className="sheet-head">
        <div className="title-row">
          <h2 className="title">{league}</h2>
          <button className="link-action" onClick={onClose}>Done</button>
        </div>
        <div className="subtitle">Where this league's lineups come from</div>
      </div>
      <div className="sheet-body sc">
        <div className="src3">
          {[['manual', 'By hand'], ['sleeper', 'Sleeper'], ['espn', 'ESPN']].map(([k, label]) => (
            <button key={k} className={c.source === k ? 'on' : ''} onClick={() => pickSource(k)}>{label}</button>
          ))}
        </div>

        {c.source === 'manual' && (
          <div className="pane"><div className="note" style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
            Update this league each week by editing its players. Nothing is fetched automatically.
          </div></div>
        )}

        {c.source === 'sleeper' && (
          <div className="pane">
            <div>
              <div className="field-l">Sleeper username</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input className="input" style={{ flex: 1 }} value={sleeperUser} onChange={e => setSleeperUser(e.target.value)} placeholder="username" autoCapitalize="off" autoCorrect="off" autoComplete="off" />
                <button className="btn btn-ink" style={{ flex: 'none', padding: '15px 14px' }} onClick={findSleeper}>Find leagues</button>
              </div>
            </div>
            {c.leagueId
              ? <div className="msg ok">Linked to {c.name || 'Sleeper league ' + c.leagueId}.</div>
              : syncErr && <div className="msg err">{syncErr}</div>}
            <div className="msg">{sleeperMsg}</div>
            {(sleeperList || []).map(s => (
              <button key={s.league_id} className={'pick' + (c.leagueId === s.league_id ? ' on' : '')} disabled={takenIds.includes(s.league_id)} style={takenIds.includes(s.league_id) ? { opacity: 0.45 } : null}
                onClick={() => { setConn({ leagueId: s.league_id, name: s.name }); setSleeperMsg('Saved. Tap Done to pull this week\'s lineups.'); }}>
                <span className="pick-name">{s.name}</span>
                <span className="pick-meta">{takenIds.includes(s.league_id) ? 'Linked to another league' : (s.total_rosters || '') + ' teams'}</span>
              </button>
            ))}
            <div className="note">Sleeper's API is public and read-only — no password needed. Starters for both teams refresh every time you open the app.</div>
          </div>
        )}

        {c.source === 'espn' && (
          <div className="pane">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
              <label>
                <div className="field-l">League ID</div>
                <input className="input" value={c.leagueId || ''} onChange={e => setConn({ leagueId: e.target.value.replace(/\D/g, '') })} inputMode="numeric" placeholder="e.g. 1234567" />
              </label>
              <label>
                <div className="field-l">Your team ID</div>
                <input className="input" value={c.teamId || ''} onChange={e => setConn({ teamId: e.target.value.replace(/\D/g, '') })} inputMode="numeric" placeholder="e.g. 4" />
              </label>
            </div>
            <button className="btn btn-ink" onClick={runEspn}>Test connection</button>
            <div className={'msg ' + (/^Connected/.test(espnMsg) ? 'ok' : 'err')}>{espnMsg}</div>
            <div className="note">Both IDs are in your team page URL on fantasy.espn.com, after "leagueId" and "teamId". ESPN only shares lineups for leagues set to public (League → Settings → "Make league viewable to public"). Private leagues have to be edited by hand. Syncs week {week}.</div>
          </div>
        )}
      </div>
    </div>
  );
}

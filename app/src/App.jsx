import { useCallback, useEffect, useRef, useState } from 'react';
import { LEAGUE_NAMES, PLAYERS } from './data.js';
import { LS, load, save } from './lib/store.js';
import { SEASON, WEEKS, currentWeek, seedWeek } from './lib/season.js';
import { mkPlayer } from './lib/teams.js';
import { Avatar, Icon, PosChip, Segmented, Sheet, Switch, TeamLogo, leagueColor } from './ui.jsx';
import { groupByGame } from './lib/games.js';
import { matchSleeperLeague, sleeperLeagues, syncSleeper } from './lib/sleeper.js';
import { syncEspn } from './lib/espn.js';

function syncEspnFor(c, week, helper) {
  if (c.private && !helper) return Promise.reject(new Error('Private league: add your ESPN helper link under Connect.'));
  return syncEspn(c.leagueId, c.teamId, week, c.private ? helper : '');
}

const DEFAULT_USER = 'Uncutgems82';
const DEFAULT_CONN = {
  RDL: { source: 'sleeper' },
  DFL: { source: 'sleeper' },
  Deloitte: { source: 'espn', leagueId: '308619009', teamId: '1' },
  Breezewood: { source: 'espn', private: true }
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
  // Weeks saved before a league was added get that league's starting lineup.
  Object.keys(data).forEach(w => {
    const missing = LEAGUE_NAMES.filter(n => !data[w][n]);
    if (missing.length) { const seed = seedWeek(Number(w), data); missing.forEach(n => { data[w][n] = seed[n]; }); }
  });
  return {
    week, data,
    scored: s.scored || {},
    conn: mergeConn(s.conn || {}),
    sleeperUser: s.sleeperUser || DEFAULT_USER,
    espnHelper: s.espnHelper || '',
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
      const cur = wk[league] || { mine: [], opp: [] };
      const l = { mine: [...cur.mine], opp: [...cur.opp] };
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
    return syncEspnFor(c, week, dbRef.current.espnHelper);
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
  const scoredWeek = db.scored[week] || {};

  return (
    <div className="app">
      <header className="head">
        <div className="head-row">
          <div>
            <div className="eyebrow">{SEASON} season</div>
            <h1 className="title">{screen === 'games' ? 'Week ' + week : 'Leagues'}</h1>
          </div>
          <button className={'icon-btn' + (syncing ? ' spinning' : '')} disabled={syncing} onClick={() => syncAll(false)} aria-label="Sync connected leagues">
            <Icon.refresh size={19} />
          </button>
        </div>
        <WeekPills week={week} onPick={setWeek} />
      </header>

      <main className="body" key={screen}>
        {screen === 'games'
          ? <Games week={week} wk={wk} scored={scoredWeek} filter={filter} setFilter={setFilter} onToggle={toggleScored} />
          : <Leagues week={week} wk={wk} conn={db.conn} synced={db.synced} syncing={syncing}
              onSync={async n => { if (await syncOne(n, week)) flash(n + ' synced'); }}
              onEdit={setEditFor} onConnect={setConnFor} />}
      </main>

      <nav className="tabbar">
        <button className={screen === 'games' ? 'on' : ''} onClick={() => setScreen('games')}><Icon.football size={23} /><span>Games</span></button>
        <button className={screen === 'leagues' ? 'on' : ''} onClick={() => setScreen('leagues')}><Icon.trophy size={23} /><span>Leagues</span></button>
      </nav>

      {editFor && <EditSheet league={editFor} week={week} lineup={wk[editFor] || { mine: [], opp: [] }}
        onEdit={fn => editLeague(editFor, fn)} onClose={() => setEditFor(null)} />}

      {connFor && <ConnectSheet league={connFor} week={week} conn={db.conn[connFor] || { source: 'manual' }}
        sleeperUser={db.sleeperUser} setSleeperUser={u => setDb(prev => ({ ...prev, sleeperUser: u }))}
        setConn={patch => setConn(connFor, patch)}
        syncErr={(db.synced[connFor + ':' + week] || {}).err}
        takenIds={LEAGUE_NAMES.filter(n => n !== connFor && db.conn[n] && db.conn[n].source === 'sleeper').map(n => db.conn[n].leagueId).filter(Boolean)}
        espnHelper={db.espnHelper} setEspnHelper={u => setDb(prev => ({ ...prev, espnHelper: u.trim() }))}
        testEspn={async c => { const res = await syncEspnFor(c, week, db.espnHelper); setLeague(week, connFor, res, 'espn'); markSynced(connFor + ':' + week, { ok: true }); return res; }}
        onClose={closeConn} />}

      {toast && <div className="toast" role="status" key={toast}>{toast}</div>}
    </div>
  );
}

function WeekPills({ week, onPick }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current && ref.current.querySelector('.on');
    if (el) el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [week]);
  const now = currentWeek();
  const pills = [];
  for (let w = 1; w <= WEEKS; w++) {
    pills.push(
      <button key={w} className={'wpill' + (w === week ? ' on' : '') + (w === now ? ' now' : '')} onClick={() => onPick(w)} aria-label={'Week ' + w}>
        {w}
      </button>
    );
  }
  return <div className="weeks sc" ref={ref}><span className="weeks-l">WK</span>{pills}</div>;
}

const TagList = ({ leagues }) => (
  <span className="ltags">
    {leagues.map(l => <span key={l} className="ltag" style={{ '--lc': leagueColor(l, LEAGUE_NAMES) }}>{l}</span>)}
  </span>
);

function PlayerRow({ p, side, done, onToggle }) {
  return (
    <button className={'prow' + (done ? ' done' : '')} onClick={onToggle} aria-pressed={done}>
      <Avatar p={p} side={side} />
      <span className="prow-main">
        <span className="prow-name">{p.name}</span>
        <span className="prow-meta"><PosChip pos={p.pos} /><span>{p.team}</span></span>
      </span>
      <TagList leagues={p.leagues} />
      <span className="prow-check" aria-hidden="true">{done ? <Icon.check size={14} sw={3} /> : null}</span>
    </button>
  );
}

function StatusPill({ status }) {
  if (status === 'Live') return <span className="spill live"><i />Live</span>;
  return <span className={'spill' + (status === 'Final' ? ' final' : '')}>{status}</span>;
}

function Games({ week, wk, scored, filter, setFilter, onToggle }) {
  const { games, bye } = groupByGame(week, wk);
  const shown = games.filter(g => filter === 'all' || g.mine.length);
  if (filter === 'all' && (bye.mine.length || bye.theirs.length)) {
    shown.push({ key: 'bye', bye: true, title: 'Bye or unmatched', time: 'No game this week for these teams', status: 'Check', ...bye });
  }
  const all = shown.flatMap(g => g.mine.concat(g.theirs));
  const yours = shown.reduce((s, g) => s + g.mine.length, 0);
  const against = shown.reduce((s, g) => s + g.theirs.length, 0);
  const done = all.filter(p => scored[p.uid]).length;

  return (
    <div className="stack">
      <div className="card summary">
        <div className="sum-cell"><span className="sum-n">{shown.filter(g => !g.bye).length}</span><span className="sum-l">Games</span></div>
        <div className="sum-cell"><span className="sum-n mint">{yours}</span><span className="sum-l">Your starters</span></div>
        <div className="sum-cell"><span className="sum-n coral">{against}</span><span className="sum-l">Against you</span></div>
        <div className="sum-bar" aria-label={done + ' of ' + all.length + ' checked off'}>
          <span style={{ width: (all.length ? (done / all.length) * 100 : 0) + '%' }} />
        </div>
        <div className="sum-foot">{done} of {all.length} checked off</div>
      </div>

      <Segmented value={filter} onChange={setFilter} options={[['all', 'All games'], ['mine', 'My players']]} />

      {shown.map(g => {
        const [away, home] = g.bye ? [null, null] : g.key.split('@');
        return (
          <section key={g.key} className="card game">
            <div className="game-head">
              {g.bye
                ? <div className="matchup"><span className="bye-t">{g.title}</span></div>
                : <div className="matchup">
                    <TeamLogo team={away} size={30} /><span className="abbr">{away}</span>
                    <span className="at">@</span>
                    <TeamLogo team={home} size={30} /><span className="abbr">{home}</span>
                  </div>}
              <StatusPill status={g.status} />
            </div>
            <div className="game-time">{g.time}</div>
            {g.mine.length > 0 && (
              <div className="side">
                <div className="side-h mint"><i />Your players</div>
                {g.mine.map(p => <PlayerRow key={p.uid} p={p} side="mine" done={!!scored[p.uid]} onToggle={() => onToggle(p.uid)} />)}
              </div>
            )}
            {g.theirs.length > 0 && (
              <div className="side">
                <div className="side-h coral"><i />Against you</div>
                {g.theirs.map(p => <PlayerRow key={p.uid} p={p} side="opp" done={!!scored[p.uid]} onToggle={() => onToggle(p.uid)} />)}
              </div>
            )}
          </section>
        );
      })}

      {shown.length
        ? <p className="hint">Tap a player to check them off once their game is done.</p>
        : <div className="card empty">
            <Icon.football size={28} />
            <div className="empty-t">No lineups for week {week}</div>
            <div className="empty-d">Connect a league on the Leagues tab, or add players by hand.</div>
          </div>}
    </div>
  );
}

function Leagues({ week, wk, conn, synced, syncing, onSync, onEdit, onConnect }) {
  return (
    <div className="stack">
      {LEAGUE_NAMES.map(n => {
        const l = wk[n] || { mine: [], opp: [] };
        const c = conn[n] || { source: 'manual' };
        const sy = synced[n + ':' + week];
        const linked = isLinked(c);
        const failed = sy && !sy.ok && !(l.at > sy.at);
        const when = l.at ? new Date(l.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
        const status = failed ? sy.err
          : l.how === 'manual' ? 'Edited by hand · ' + when
          : l.how ? 'Updated from ' + SRC_NAME[l.how] + ' · ' + when
          : 'Using last week\'s lineup';
        const StatusIcon = failed ? Icon.alert : l.how ? Icon.check : Icon.clock;
        const color = leagueColor(n, LEAGUE_NAMES);
        return (
          <section key={n} className="card league">
            <div className="league-head">
              <span className="lavatar" style={{ '--lc': color }}>{n.slice(0, 2)}</span>
              <div className="league-id">
                <div className="league-name">{n}</div>
                <div className="league-src">
                  {linked ? SRC_NAME[c.source] : 'Not connected'}
                  {c.source === 'espn' && c.private ? <> · <Icon.lock size={11} sw={2.5} /> Private</> : null}
                </div>
              </div>
              <div className="league-vs"><b>{l.mine.length}</b><span>vs</span><b>{l.opp.length}</b></div>
            </div>
            <div className={'league-status' + (failed ? ' err' : l.how ? ' ok' : '')}><StatusIcon size={14} sw={2.5} /><span>{status}</span></div>
            <div className="league-actions">
              {linked && <button className="pill-btn primary" disabled={syncing} onClick={() => onSync(n)}><Icon.refresh size={15} sw={2.5} />Sync</button>}
              <button className={'pill-btn' + (linked ? '' : ' primary')} onClick={() => onEdit(n)}><Icon.pencil size={15} sw={2.5} />Edit</button>
              <button className="pill-btn" onClick={() => onConnect(n)}><Icon.link size={15} sw={2.5} />{linked ? 'Source' : 'Connect'}</button>
            </div>
          </section>
        );
      })}
      <p className="hint">Lineups are saved on this phone. Connected leagues refresh whenever you open the app.</p>
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
    <Sheet title={league} subtitle={'Week ' + week + ' lineup'} onClose={onClose} label={'Edit ' + league}>
      <Segmented value={side} onChange={setSide} tone={v => v === 'opp' ? 'coral' : ''}
        options={[['mine', 'My starters · ' + lineup.mine.length], ['opp', 'Opponent · ' + lineup.opp.length]]} />
      <label className="search">
        <Icon.search size={17} />
        <input id="add-player" value={query} onChange={e => setQuery(e.target.value)} placeholder="Add a player" autoComplete="off" autoCorrect="off" enterKeyHint="search" />
      </label>
      {results.length > 0 && (
        <div className="list">
          {results.map(p => (
            <button key={p.n + p.t} className="lrow" onClick={() => { onEdit(l => { l[side] = [...l[side], mkPlayer(p)]; }); setQuery(''); }}>
              <Avatar p={{ pos: p.p, team: p.t }} size={34} />
              <span className="lrow-main"><span className="lrow-name">{p.n}</span><span className="prow-meta"><PosChip pos={p.p} /><span>{p.t}</span></span></span>
              <span className="round-btn add"><Icon.plus size={16} sw={2.5} /></span>
            </button>
          ))}
        </div>
      )}
      <div className="list">
        {list.map(p => (
          <div key={p.id} className="lrow">
            <Avatar p={p} size={34} side={side} />
            <span className="lrow-main"><span className="lrow-name">{p.name}</span><span className="prow-meta"><PosChip pos={p.pos} /><span>{p.team}</span></span></span>
            <button className="round-btn remove" aria-label={'Remove ' + p.name} onClick={() => onEdit(l => { l[side] = l[side].filter(x => x.id !== p.id); })}><Icon.minus size={16} sw={2.5} /></button>
          </div>
        ))}
        {!list.length && <div className="lrow muted">No players yet. Search above to add them.</div>}
      </div>
    </Sheet>
  );
}

function ConnectSheet({ league, week, conn, sleeperUser, setSleeperUser, setConn, syncErr, takenIds, espnHelper, setEspnHelper, testEspn, onClose }) {
  const [sleeperList, setSleeperList] = useState(null);
  const [sleeperMsg, setSleeperMsg] = useState('');
  const [espnMsg, setEspnMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const c = conn;

  const findSleeper = async () => {
    setSleeperMsg('Looking up leagues…');
    setSleeperList(null);
    try {
      const list = await sleeperLeagues(sleeperUser);
      setSleeperList(list);
      setSleeperMsg(list.length ? '' : 'No ' + SEASON + ' leagues on that account.');
    } catch (e) { setSleeperMsg(e.message); }
  };

  // List the account's leagues straight away so picking one is a single tap.
  useEffect(() => { if (c.source === 'sleeper') findSleeper(); }, [c.source]); // eslint-disable-line react-hooks/exhaustive-deps

  const runEspn = async () => {
    if (!c.leagueId || !c.teamId) { setEspnMsg('Enter both IDs.'); return; }
    setBusy(true);
    setEspnMsg('');
    try {
      const res = await testEspn(c);
      setEspnMsg('Connected — pulled ' + res.mine.length + ' + ' + res.opp.length + ' starters.');
    } catch (e) { setEspnMsg(e.message); }
    setBusy(false);
  };

  const pickSource = s => setConn({ source: s, leagueId: s === c.source ? c.leagueId : '', teamId: s === c.source ? c.teamId : '' });
  const ok = /^Connected/.test(espnMsg);

  return (
    <Sheet title={league} subtitle="Where this league's lineups come from" onClose={onClose} label={'Connect ' + league}>
      <Segmented value={c.source} onChange={pickSource} options={[['sleeper', 'Sleeper'], ['espn', 'ESPN'], ['manual', 'By hand']]} />

      {c.source === 'manual' && (
        <p className="sheet-note">You'll update this league each week by editing its players. Nothing is fetched automatically.</p>
      )}

      {c.source === 'sleeper' && (
        <>
          <div className="field">
            <label htmlFor="sleeper-user">Sleeper username</label>
            <div className="field-row">
              <input id="sleeper-user" className="input" value={sleeperUser} onChange={e => setSleeperUser(e.target.value)} placeholder="username" autoCapitalize="off" autoCorrect="off" autoComplete="off" />
              <button className="pill-btn" onClick={findSleeper}><Icon.search size={15} sw={2.5} />Find</button>
            </div>
          </div>
          {!c.leagueId && syncErr && <div className="banner err"><Icon.alert size={16} sw={2.5} /><span>{syncErr}</span></div>}
          {sleeperMsg && <div className="sheet-note">{sleeperMsg}</div>}
          {sleeperList && sleeperList.length > 0 && (
            <div className="list">
              <div className="list-h">Pick your {league} league</div>
              {sleeperList.map(s => {
                const taken = takenIds.includes(s.league_id);
                const on = c.leagueId === s.league_id;
                return (
                  <button key={s.league_id} className={'lrow pick' + (on ? ' on' : '')} disabled={taken}
                    onClick={() => { setConn({ leagueId: s.league_id, name: s.name }); setSleeperMsg('Saved. Tap Done to pull this week\'s lineups.'); }}>
                    <span className="lrow-main">
                      <span className="lrow-name">{s.name}</span>
                      <span className="lrow-sub">{taken ? 'Linked to another league' : (s.total_rosters || '') + ' teams'}</span>
                    </span>
                    <span className={'radio' + (on ? ' on' : '')}>{on && <Icon.check size={13} sw={3.5} />}</span>
                  </button>
                );
              })}
            </div>
          )}
          <p className="sheet-note">Sleeper is read-only and needs no password. Both lineups refresh when you open the app.</p>
        </>
      )}

      {c.source === 'espn' && (
        <>
          <div className="field-grid">
            <div className="field">
              <label htmlFor="espn-league">League ID</label>
              <input id="espn-league" className="input" value={c.leagueId || ''} onChange={e => setConn({ leagueId: e.target.value.replace(/\D/g, '') })} inputMode="numeric" placeholder="1234567" />
            </div>
            <div className="field">
              <label htmlFor="espn-team">Your team ID</label>
              <input id="espn-team" className="input" value={c.teamId || ''} onChange={e => setConn({ teamId: e.target.value.replace(/\D/g, '') })} inputMode="numeric" placeholder="4" />
            </div>
          </div>
          <div className="list">
            <Switch on={c.private} onChange={v => setConn({ private: v })} label="Private league" hint="Read through your ESPN helper, which holds your ESPN login." />
          </div>
          {c.private && (
            <div className="field">
              <label htmlFor="espn-helper">ESPN helper link</label>
              <input id="espn-helper" className="input" value={espnHelper} onChange={e => setEspnHelper(e.target.value)} inputMode="url" placeholder="https://espn-helper.you.workers.dev" autoCapitalize="off" autoCorrect="off" autoComplete="off" />
            </div>
          )}
          <button className="pill-btn primary wide" disabled={busy} onClick={runEspn}>{busy ? 'Connecting…' : 'Test connection'}</button>
          {espnMsg && <div className={'banner ' + (ok ? 'ok' : 'err')}>{ok ? <Icon.check size={16} sw={2.5} /> : <Icon.alert size={16} sw={2.5} />}<span>{espnMsg}</span></div>}
          <p className="sheet-note">Both IDs are in your team page's web address on fantasy.espn.com, after "leagueId=" and "teamId=". {c.private
            ? 'The helper is a free Cloudflare Worker you set up once; the steps are in espn-helper/README.md in the app\'s GitHub repo.'
            : 'Without the helper, ESPN only shares leagues that are set to public.'} Syncs week {week}.</p>
        </>
      )}
    </Sheet>
  );
}

import { SEASON } from './season.js';
import { LS_PL, load, save } from './store.js';
import { defName, normTeam } from './teams.js';

const API = 'https://api.sleeper.app/v1/';

async function sj(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error('Sleeper ' + r.status);
  return r.json();
}

const userIds = {};
export async function sleeperUserId(username) {
  const u = String(username || '').trim();
  if (!u) throw new Error('Add your Sleeper username first.');
  if (userIds[u]) return userIds[u];
  const user = await sj('user/' + encodeURIComponent(u));
  if (!user || !user.user_id) throw new Error('No Sleeper user named "' + u + '".');
  return (userIds[u] = user.user_id);
}

export async function sleeperLeagues(username) {
  const uid = await sleeperUserId(username);
  return (await sj('user/' + uid + '/leagues/nfl/' + SEASON)) || [];
}

const initials = s => s.split(/[^a-z0-9]+/i).filter(Boolean).map(w => w[0]).join('').toLowerCase();

// Finds the Sleeper league whose name contains, or whose initials spell, our league's short name.
export async function matchSleeperLeague(username, league) {
  const key = league.toLowerCase();
  const hits = (await sleeperLeagues(username)).filter(l => {
    const nm = String(l.name || '').toLowerCase();
    return nm.includes(key) || initials(nm) === key;
  });
  if (hits.length !== 1) throw new Error('Couldn\'t match ' + league + ' to a Sleeper league. Tap Connect and pick it once.');
  return { leagueId: hits[0].league_id, name: hits[0].name };
}

const isTeamDef = id => /^[A-Z]{2,3}$/.test(id);
let allPlayers = null;

// Sleeper's full player list is several MB, so only the names we have seen are cached on the device.
async function resolvePlayers(ids) {
  const cache = load(LS_PL, {});
  const missing = ids.filter(id => !cache[id] && !isTeamDef(id));
  if (missing.length) {
    allPlayers = allPlayers || await sj('players/nfl');
    missing.forEach(id => {
      const p = allPlayers[id];
      if (p) cache[id] = { n: ((p.first_name || '') + ' ' + (p.last_name || '')).trim(), p: p.position, t: p.team };
    });
    save(LS_PL, cache);
  }
  return ids.map(id => {
    if (isTeamDef(id)) return { n: defName(id), p: 'DEF', t: normTeam(id) };
    const c = cache[id];
    return c ? { n: c.n, p: c.p, t: c.t } : { n: 'Player ' + id, p: '', t: '' };
  });
}

const realIds = list => (list || []).filter(id => id && id !== '0');

export async function syncSleeper(username, leagueId, week) {
  const uid = await sleeperUserId(username);
  const rosters = await sj('league/' + leagueId + '/rosters');
  const mine = rosters.find(r => r.owner_id === uid || (r.co_owners || []).includes(uid));
  if (!mine) throw new Error('Your team isn\'t in that Sleeper league.');
  const ms = (await sj('league/' + leagueId + '/matchups/' + week)) || [];
  const me = ms.find(m => m.roster_id === mine.roster_id);
  if (!me) throw new Error('No week ' + week + ' matchup yet.');
  const opp = ms.find(m => m.matchup_id === me.matchup_id && m.roster_id !== me.roster_id);
  const myIds = realIds(me.starters && me.starters.length ? me.starters : mine.starters);
  const opIds = realIds(opp && opp.starters);
  const players = await resolvePlayers(myIds.concat(opIds));
  return { mine: players.slice(0, myIds.length), opp: players.slice(myIds.length) };
}

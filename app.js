const API = 'https://statsapi.mlb.com';
const REFRESH_MS = 5 * 60 * 1000;
const SMALL_SAMPLE_AB = 20;
const UMP_ABBR = {
  'Home Plate': 'HP', 'First Base': '1B', 'Second Base': '2B',
  'Third Base': '3B', 'Left Field': 'LF', 'Right Field': 'RF',
};

const POSTSEASON_TYPES = ['F', 'D', 'L', 'W'];
// Coaching staff shown, in display order. Matched by job name because each interim role has its own
// job id (e.g. NTRM for Interim Manager).
// Values are the short labels printed on the card.
const CORE_COACH_JOBS = { 'Manager': 'Manager', 'Bench Coach': 'Bench', 'First Base Coach': '1st', 'Third Base Coach': '3rd' };

const app = document.getElementById('app');
const statsNoteEl = document.getElementById('stats-note');
const navExtraEl = document.getElementById('nav-extra');
const homeLinkEl = document.getElementById('home-link');
const printLinkEl = document.getElementById('print');
const themeToggleEl = document.getElementById('theme-toggle');
let refreshTimer = null;
let viewToken = 0;
let usePostseasonStats = false;

async function getJSON(path) {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${path})`);
  return res.json();
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function localDateISO(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 'YYYY-MM-DD' -> local Date, or null if it isn't a real date.
function parseISODate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return localDateISO(date) === s ? date : null;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function fmtTime(iso, timeZone) {
  return new Date(iso).toLocaleTimeString([], {
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    ...(timeZone && { timeZone }),
  });
}

function table(headers, rows, numCols = [], groupStart = -1) {
  const nameCol = headers.indexOf('Name');
  const cell = (tag, v, i) => {
    const cls = [numCols.includes(i) && 'num', i === nameCol && 'name-col'].filter(Boolean).join(' ');
    return `<${tag}${cls ? ` class="${cls}"` : ''}>${v}</${tag}>`;
  };
  const row = (r, n) => `<tr${n === groupStart ? ' class="group-start"' : ''}>${r.map((v, i) => cell('td', v, i)).join('')}</tr>`;
  return `<table><thead><tr>${headers.map((h, i) => cell('th', h.html ?? esc(h), i)).join('')}</tr></thead>
    <tbody>${rows.map(row).join('')}</tbody></table>`;
}

function syncThemeToggle() {
  themeToggleEl.textContent = document.documentElement.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode';
}

themeToggleEl.addEventListener('click', e => {
  e.preventDefault();
  const root = document.documentElement;
  if (root.dataset.theme === 'dark') delete root.dataset.theme;
  else root.dataset.theme = 'dark';
  try { localStorage.setItem('theme', root.dataset.theme ?? 'light'); } catch (err) {}
  syncThemeToggle();
});
syncThemeToggle();

function route() {
  clearTimeout(refreshTimer);
  statsNoteEl.textContent = '';
  navExtraEl.innerHTML = '';
  const token = ++viewToken;
  const hash = location.hash.slice(1);
  const isGame = /^\d+$/.test(hash);
  document.body.classList.toggle('list-view', !isGame);
  homeLinkEl.hidden = hash === '';
  printLinkEl.hidden = !isGame;
  const view = isGame
    ? showGame(hash, token)
    : showList(parseISODate(hash) ?? new Date(), token);
  view.catch(err => {
    if (token !== viewToken) return;
    app.innerHTML = `<p class="error">Could not load data: ${esc(err.message)}</p>
      <p><button type="button" onclick="route()">Retry</button></p>`;
  });
}

window.addEventListener('hashchange', route);
route();

// ---------- Game list ----------

function dateNavHtml(date) {
  const today = localDateISO();
  const isToday = localDateISO(date) === today;
  const link = (days, label) => {
    const iso = localDateISO(addDays(date, days));
    return `<a href="#${iso === today ? '' : iso}">${label}</a>`;
  };
  return `<header class="date-nav">
    <span class="prev no-print">${link(-1, isToday ? 'Yesterday' : 'Previous day')}</span>
    <h1>${esc(date.toDateString())}</h1>
    <span class="next no-print">${link(1, isToday ? 'Tomorrow' : 'Next day')}</span>
  </header>`;
}

async function showList(date, token) {
  app.textContent = 'Loading games...';
  const iso = localDateISO(date);
  const data = await getJSON(`/api/v1/schedule?sportId=1&date=${iso}&hydrate=team`);
  if (token !== viewToken) return;

  const games = data.dates.flatMap(d => d.games);
  const heading = dateNavHtml(date);
  if (!games.length) {
    app.innerHTML = `${heading}<p>No MLB games on this date.</p>`;
    return;
  }

  // Times are in the viewer's zone, so it's named once in the header instead of on every row.
  const tz = new Intl.DateTimeFormat([], { timeZoneName: 'short' })
    .formatToParts(new Date(games[0].gameDate)).find(p => p.type === 'timeZoneName')?.value;
  const rows = games.map(g => {
    const time = g.status.startTimeTBD ? 'TBD'
      : new Date(g.gameDate).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    // Each side stays on one line, so a wrap can only happen right after the '@'.
    const matchup = `<a href="#${g.gamePk}"><span class="nowrap">${esc(g.teams.away.team.name)} @</span> <span class="nowrap">${esc(g.teams.home.team.name)}</span></a>`;
    return [esc(time), matchup, `<span class="status">${esc(g.status.detailedState)}</span>`];
  });
  app.innerHTML = heading + `<div class="games">${table([tz ? `Time (${tz})` : 'Time', 'Matchup', 'Status'], rows)}</div>`;
}

// ---------- Single game ----------

function buildSide(side, gd, box) {
  const t = box.teams[side];
  const players = Object.values(t.players);
  const starters = players
    .filter(p => p.battingOrder?.endsWith('00'))
    .sort((a, b) => Number(a.battingOrder) - Number(b.battingOrder))
    .map(p => p.person.id);
  const pitchersUsed = t.pitchers ?? [];
  const starter = pitchersUsed[0] ?? gd.probablePitchers?.[side]?.id ?? null;
  const allPitchers = [...new Set([...pitchersUsed, ...(t.bullpen ?? [])])];
  const bench = [...new Set([...(t.batters ?? []), ...(t.bench ?? [])])]
    .filter(id => !starters.includes(id) && !allPitchers.includes(id));
  const bullpen = allPitchers.filter(id => id !== starter);
  const startPos = id => {
    const p = t.players[`ID${id}`];
    return p?.allPositions?.[0]?.abbreviation ?? p?.position?.abbreviation ?? '';
  };
  const jersey = id => t.players[`ID${id}`]?.jerseyNumber;
  return { side, team: gd.teams[side], starters, bench, bullpen, starter, startPos, jersey };
}

function seasonStat(person, group) {
  const entry = person?.stats?.find(s => s.group?.displayName === group);
  const splits = entry?.splits ?? [];
  // Traded players get one split per team plus a combined split with no team.
  const split = splits.find(s => !s.team) ?? (splits.length === 1 ? splits[0] : splits.at(-1));
  return split?.stat;
}

// "Cristopher Sánchez" -> "C. Sánchez". Strips the first name as MLB uses it, so
// multi-word first names ("Jung Hoo Lee") and last names ("De La Cruz", "Acuña Jr.") stay intact.
function shortName(person) {
  const full = person?.fullName;
  const first = person?.useName ?? person?.firstName;
  if (!full || !first || !full.startsWith(`${first} `)) return null;
  return `${first[0]}. ${full.slice(first.length + 1)}`;
}

function battingCells(stat) {
  if (!stat) return ['-', '', ''];
  if (stat.atBats < SMALL_SAMPLE_AB) return [`${stat.hits}/${stat.atBats}`, '', ''];
  return [stat.avg, stat.obp, stat.ops];
}

function pitchingCells(stat) {
  if (!stat) return ['-', '-', '-'];
  return [`${stat.wins}-${stat.losses}`, stat.era, stat.whip];
}

// Park outlines by venue id, built from Baseball Savant by tools/build-stadiums.js. Loaded once.
let stadiumsPromise = null;
function loadStadiums() {
  stadiumsPromise ??= fetch('stadiums.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
  return stadiumsPromise;
}

async function fetchStandings(season, statType) {
  const standings = await getJSON((statType === 'S'
    ? `/api/v1/standings?leagueId=114,115&season=${season}&standingsTypes=springTraining`
    : `/api/v1/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`) +
    '&hydrate=team,division');
  // Spring training leaves gamesBack as "-" for every team; the real value is springLeagueGamesBack.
  if (statType === 'S') {
    for (const tr of (standings.records ?? []).flatMap(r => r.teamRecords)) tr.gamesBack = tr.springLeagueGamesBack;
  }
  return standings;
}

// The division (or spring league) record group a team is in.
function findTeamGroup(standings, teamId) {
  return standings.records?.find(r => r.teamRecords.some(tr => tr.team.id === teamId)) ?? null;
}

// For a division leader, show the lead over second place as "(+6)" instead of "-".
function gamesBackCell(group, tr) {
  if (tr.gamesBack !== '-') return tr.gamesBack;
  const lead = Math.min(...group.teamRecords
    .filter(x => x !== tr)
    .map(x => parseFloat(x.gamesBack) || 0));
  return lead > 0 && Number.isFinite(lead) ? `(+${lead})` : '-';
}

function startTimeHtml(gd) {
  if (gd.status.startTimeTBD) return 'TBD';
  return esc(fmtTime(gd.datetime.dateTime, gd.venue.timeZone?.id));
}

// One table per division the two teams play in (one if they share it). Spring training groups
// by Cactus / Grapefruit League, which the API only names on each team.
function standingsHtml(sides, standings) {
  const playing = sides.map(s => s.team.id);
  const groups = [...new Set(playing.map(id => findTeamGroup(standings, id)))].filter(Boolean);
  if (!groups.length) return '<h2>Standings</h2><p>Not yet available</p>';
  const tableFor = group => {
    // "AL Central" on wide screens, "ALC" in print and on phones where it would wrap.
    const spring = group.teamRecords[0]?.team?.springLeague?.name ?? '';
    const full = group.division?.nameShort ?? spring;
    const short = group.division?.abbreviation ?? spring.replace(/ League$/, '');
    const name = { html: `<span class="full">${esc(full)}</span><span class="short">${esc(short)}</span>` };
    const rows = group.teamRecords.map(tr => {
      const b = v => playing.includes(tr.team.id) ? `<b>${esc(v)}</b>` : esc(v);
      return [b(tr.team.abbreviation ?? tr.team.name), b(tr.gamesBack)];
    });
    return table([name, 'GB'], rows, [1]);
  };
  return `<h2>Standings</h2><div class="division-standings${groups.length === 1 ? ' single' : ''}">
    ${groups.map(tableFor).join('')}</div>`;
}

function statToggleHtml(statType) {
  return `<label>Stats:<select id="stat-type">
      <option value="R"${statType === 'R' ? ' selected' : ''}>Regular season</option>
      <option value="P"${statType === 'P' ? ' selected' : ''}>Postseason</option>
    </select></label>`;
}

function gameInfoHtml(gd, live, sched, parkSvg) {
  const series = sched && sched.gameType !== 'R' && sched.seriesDescription
    ? `${sched.seriesDescription}${sched.seriesGameNumber ? `, Game ${sched.seriesGameNumber}` : ''}`
    : '';
  // officialDate is a plain YYYY-MM-DD; read it as UTC so the day never shifts.
  const date = new Date(`${gd.datetime.officialDate}T00:00Z`)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const plays = live.plays?.allPlays ?? [];
  const started = plays.some(p => p.playEvents?.some(e => e.isPitch));
  const final = gd.status.abstractGameState === 'Final';
  const info = label => live.boxscore.info?.find(i => i.label === label)?.value?.replace(/\.$/, '');
  const w = gd.weather ?? {};
  const condition = w.condition === 'Partly Cloudy' ? 'P. Cloudy' : w.condition;
  const weather = [condition, w.temp && `${w.temp}°`].filter(Boolean).join(' ');
  const endTime = final && started && plays.at(-1).about?.endTime;
  const duration = final ? info('T') : null;
  // International venues (e.g. Mexico City) have no state, so fall back to the country.
  const loc = gd.venue.location ?? {};
  const cityState = [loc.city, loc.stateAbbrev ?? loc.country].filter(Boolean).join(', ');
  // Standing-room crowds can top 100% of capacity; show that as-is.
  const att = gd.gameInfo?.attendance;
  const capacity = gd.venue.fieldInfo?.capacity;
  const attendance = att
    ? `${att.toLocaleString()}${capacity ? ` (${Math.round(att / capacity * 100)}%)` : ''}`
    : '-';

  const items = [
    ['Date', esc(date)],
    ['Stadium', esc(gd.venue.name)],
    ['Location', esc(cityState || '-')],
    ['Attendance', esc(attendance)],
    ['Weather', esc(weather || 'Not yet available')],
    ['Wind', esc(w.wind || 'Not yet available')],
    ['Start', startTimeHtml(gd)],
    ['First pitch', started && gd.gameInfo?.firstPitch ? esc(fmtTime(gd.gameInfo.firstPitch, gd.venue.timeZone?.id)) : '-'],
    // End time and duration only mean something once the game is over.
    ...(final ? [
      ['End time', endTime ? esc(fmtTime(endTime, gd.venue.timeZone?.id)) : '-'],
      ['Duration', esc(duration || '-')],
    ] : []),
  ];

  // Keep wind on one line ("8 mph, In From CF"); the park diagram shrinks to make room.
  const dl = `<dl class="info">${items.map(([k, v]) => `<dt>${k}</dt><dd${k === 'Wind' ? ' class="nowrap"' : ''}>${v}</dd>`).join('')}</dl>`;
  const park = parkSvg
    ? `<svg class="park" viewBox="0 10 250 225" role="img" aria-label="${esc(gd.venue.name)} field outline">${parkSvg}</svg>`
    : '';
  return `<h1>${esc(`${gd.teams.away.name} @ ${gd.teams.home.name}`)}</h1><div class="game-info">${dl}<div class="game-side">${series ? `<div class="muted series">${esc(series)}</div>` : ''}${park}</div></div>`;
}

function umpiresHtml(officials) {
  if (!officials?.length) return '<h2>Umpires</h2><p>Not yet available</p>';
  const rows = officials.map(o => [esc(UMP_ABBR[o.officialType] ?? o.officialType), esc(o.official.fullName)]);
  return `<h2>Umpires</h2>${table(['Pos', 'Name'], rows)}`;
}

// League-wide team stat queries, by name used in TEAM_STAT_GROUPS.
const TEAM_STAT_QUERIES = {
  hit: 'stats=season&group=hitting',
  fld: 'stats=season&group=fielding',
  sp: 'stats=statSplits&group=pitching&sitCodes=sp',
  rp: 'stats=statSplits&group=pitching&sitCodes=rp',
};

// Each group shares one header row: stats are [header, API stat, rank order] and rows are [label, query].
const TEAM_STAT_GROUPS = [
  { stats: [['AVG', 'avg', 'desc'], ['OBP', 'obp', 'desc'], ['OPS', 'ops', 'desc']], rows: [['', 'hit']] },
  { stats: [['DEF%', 'fielding', 'desc'], ['DP', 'doublePlays', 'desc'], ['E', 'errors', 'asc']], rows: [['', 'fld']] },
  { stats: [['ERA', 'era', 'asc'], ['WHIP', 'whip', 'asc']], rows: [['SP', 'sp'], ['RP', 'rp']] },
];

// rankings[query][stat]: every team's splits sorted by that stat; the API numbers each team's rank
// (ties share a rank).
async function teamRankings(season, statType) {
  const rankings = {};
  await Promise.all(TEAM_STAT_GROUPS.flatMap(({ stats, rows }) => rows.flatMap(([, query]) =>
    stats.map(([, stat, order]) =>
      getJSON(`/api/v1/teams/stats?${TEAM_STAT_QUERIES[query]}&sortStat=${stat}&order=${order}` +
        `&sportIds=1&season=${season}&gameType=${statType}`)
        .then(d => d.stats?.[0]?.splits ?? [], () => [])
        .then(splits => { (rankings[query] ??= {})[stat] = splits; })))));
  return rankings;
}

function teamStatsHtml(teamId, rankings) {
  const cell = (query, stat) => {
    const split = rankings[query]?.[stat]?.find(s => s.team?.id === teamId);
    const value = split?.stat?.[stat];
    if (value == null) return '-';
    return split.rank ? `${esc(value)}<i class="rank">(${esc(split.rank)})</i>` : esc(value);
  };
  // Stats line up on the right; the label spans the columns a shorter group leaves empty.
  const width = Math.max(...TEAM_STAT_GROUPS.map(g => g.stats.length));
  const rows = TEAM_STAT_GROUPS.map(({ stats, rows }) => {
    const span = width - stats.length + 1;
    return `<tr><td colspan="${span}"></td>${stats.map(([h]) => `<th class="num">${esc(h)}</th>`).join('')}</tr>` +
      rows.map(([label, query]) => `<tr><td colspan="${span}" class="num"><b>${esc(label)}</b></td>` +
        `${stats.map(([, stat]) => `<td class="num">${cell(query, stat)}</td>`).join('')}</tr>`).join('');
  }).join('');
  return `<table class="team-stats"><tbody>${rows}</tbody></table>`;
}

function teamStandingsHtml(team, standings) {
  const group = findTeamGroup(standings, team.id);
  const tr = group?.teamRecords.find(x => x.team.id === team.id);
  const split = type => {
    const s = tr?.records?.splitRecords?.find(x => x.type === type);
    return s && `${s.wins}-${s.losses}`;
  };
  const diff = tr?.runDifferential;
  const items = [
    ['Wins-Loss', tr && `${tr.wins}-${tr.losses}`],
    ['Gamesback', tr && gamesBackCell(group, tr)],
    ['Home', split('home')],
    ['Road', split('away')],
    ['Last 10', split('lastTen')],
    ['>.500', split('winners')],
    ['Score diff', diff > 0 ? `+${diff}` : diff],
  ];
  return `<dl class="standings">${items.map(([label, value]) =>
    `<div><dt>${esc(label)}</dt><dd>${esc(value ?? '-')}</dd></div>`).join('')}</dl>`;
}

function teamHtml(s, people, rankings, standings, startingPitcherIds, coaches) {
  const person = id => people.get(id);
  const name = id => {
    const full = person(id)?.fullName ?? `#${id}`;
    const short = shortName(person(id));
    if (!short || short === full) return `<span class="name">${esc(full)}</span>`;
    // --n is the full name's length in characters; style.css shows the short form when it won't fit.
    return `<span class="name fit" style="--n:${[...full].length}"><span class="full">${esc(full)}</span>` +
      `<span class="short" aria-hidden="true">${esc(short)}</span></span>`;
  };
  const bats = id => esc(person(id)?.batSide?.code ?? '');
  const throws = id => esc(person(id)?.pitchHand?.code ?? '');
  const num = id => esc(s.jersey(id) || person(id)?.primaryNumber || '');
  const bat = id => battingCells(seasonStat(person(id), 'hitting')).map(esc);
  const pitch = id => pitchingCells(seasonStat(person(id), 'pitching')).map(esc);
  const hitStat = (id, key) => esc(seasonStat(person(id), 'hitting')?.[key] ?? '-');
  const pitStat = (id, key) => esc(seasonStat(person(id), 'pitching')?.[key] ?? '-');
  const sortKey = id => [person(id)?.lastName, person(id)?.firstName].filter(Boolean).join(' ') || person(id)?.fullName || '';
  const byLastName = ids => [...ids].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  const pitcherHeaders = ['#', 'Name', 'T', 'IP', 'W-L', 'ERA', 'WHIP'];
  const pitcherNum = [0, 3, 4, 5, 6];
  const pitcherRow = id => [num(id), name(id), throws(id), pitStat(id, 'inningsPitched'), ...pitch(id)];

  // Starter line adds K and BB between W-L and ERA.
  const starterRow = id => {
    const [wl, ...rates] = pitch(id);
    return [num(id), name(id), throws(id), pitStat(id, 'inningsPitched'), wl,
      pitStat(id, 'strikeOuts'), pitStat(id, 'baseOnBalls'), ...rates];
  };
  const starter = s.starter
    ? table(['#', 'Name', 'T', 'IP', 'W-L', 'K', 'BB', 'ERA', 'WHIP'], [starterRow(s.starter)], [0, 3, 4, 5, 6, 7, 8])
    : '<p>TBD</p>';

  const lineup = s.starters.length
    ? table(['', '#', 'Name', 'Pos', 'B', 'AB', 'AVG', 'OBP', 'OPS'],
      s.starters.map((id, i) => [`<b>${i + 1}</b>`, num(id), name(id), esc(s.startPos(id)), bats(id), hitStat(id, 'atBats'), ...bat(id)]),
      [0, 1, 5, 6, 7, 8])
    : '<p>Lineup not yet available</p>';

  const bench = s.bench.length
    ? table(['#', 'Name', 'Pos', 'B', 'AB', 'AVG', 'OBP', 'OPS'],
      byLastName(s.bench).map(id => [num(id), name(id), esc(person(id)?.primaryPosition?.abbreviation ?? ''), bats(id), hitStat(id, 'atBats'), ...bat(id)]),
      [0, 4, 5, 6, 7])
    : '<p>Not yet available</p>';

  const relievers = byLastName(s.bullpen.filter(id => !startingPitcherIds.has(id)));
  const bullpenOrder = [...relievers, ...byLastName(s.bullpen.filter(id => startingPitcherIds.has(id)))];
  const bullpen = s.bullpen.length
    ? table([...pitcherHeaders, 'SV', 'HLD'],
      bullpenOrder.map(id => [...pitcherRow(id), pitStat(id, 'saves'), pitStat(id, 'holds')]),
      [...pitcherNum, 7, 8], relievers.length || -1)
    : '<p>Not yet available</p>';

  // Two columns of "Role ..... # Last name"; interim roles show the same label as the regular role.
  const role = job => CORE_COACH_JOBS[job.replace(/^Interim /, '')];
  // "A. Cora"; falls back to the full name if the API omits the parts.
  const coachName = p => {
    const first = p.useName || p.firstName, last = p.useLastName || p.lastName;
    return first && last ? `${first[0]}. ${last}` : p.fullName;
  };
  const staff = coaches.length
    ? `<dl class="standings coaches">${coaches.map(c =>
      `<div><dt>${esc(role(c.job))}</dt><dd>${esc([c.jerseyNumber, coachName(c.person)].filter(Boolean).join(' '))}</dd></div>`).join('')}</dl>`
    : '<p>Not yet available</p>';

  return `<section class="team">
    <h2>${s.side === 'away' ? 'Away' : 'Home'}: ${esc(s.team.name)}</h2>
    <div class="team-summary">
      ${teamStandingsHtml(s.team, standings)}
      ${teamStatsHtml(s.team.id, rankings)}
    </div>
    <h3>Starting pitcher</h3>${starter}
    <h3>Lineup</h3>${lineup}
    <h3>Bench</h3>${bench}
    <h3>Bullpen</h3>${bullpen}
    <h3>Coaches</h3>${staff}
  </section>`;
}

async function showGame(pk, token) {
  app.textContent = 'Loading game...';
  const feed = await getJSON(`/api/v1.1/game/${pk}/feed/live`);
  const gd = feed.gameData;
  const live = feed.liveData;
  const season = gd.game.season;
  const isPostseason = POSTSEASON_TYPES.includes(gd.game.type);
  const statType = ['S', 'E'].includes(gd.game.type) ? 'S' : (isPostseason && usePostseasonStats ? 'P' : 'R');
  const sides = ['away', 'home'].map(side => buildSide(side, gd, live.boxscore));

  const ids = [...new Set(sides.flatMap(s => [s.starter, ...s.starters, ...s.bench, ...s.bullpen]).filter(Boolean))];
  const peoplePath = `/api/v1/people?personIds=${ids.join(',')}` +
    `&hydrate=stats(group=[hitting,pitching],type=season,season=${season},gameType=${statType})`;

  const startingPitchersFor = team => getJSON(`/api/v1/teams/${team.id}/roster/depthChart?season=${season}`)
    .then(d => new Set(d.roster.filter(r => r.position?.abbreviation === 'SP').map(r => r.person.id)))
    .catch(() => new Set());

  // Staff as of the game date, so past games show who was coaching then.
  const coachesFor = team => getJSON(`/api/v1/teams/${team.id}/coaches?date=${gd.datetime.officialDate}&hydrate=person`)
    .then(d => Object.keys(CORE_COACH_JOBS).flatMap(job => (d.roster ?? []).filter(c => c.job?.replace(/^Interim /, '') === job)))
    .catch(() => []);

  const [peopleData, standings, sched, rankings, startingPitcherSets, coachSets, stadiums] = await Promise.all([
    ids.length ? getJSON(peoplePath) : { people: [] },
    fetchStandings(season, statType),
    getJSON(`/api/v1/schedule?gamePk=${pk}`).then(d => d.dates?.[0]?.games?.[0]).catch(() => null),
    teamRankings(season, statType),
    Promise.all(sides.map(s => startingPitchersFor(s.team))),
    Promise.all(sides.map(s => coachesFor(s.team))),
    loadStadiums(),
  ]);
  if (token !== viewToken) return;

  const people = new Map(peopleData.people.map(p => [p.id, p]));
  const statsNote = { S: 'spring training', P: 'postseason', R: 'regular season' }[statType];
  const isLive = gd.status.abstractGameState === 'Live';

  app.innerHTML = `
    <div class="summary">
      <section>${gameInfoHtml(gd, live, sched, stadiums[gd.venue.id])}</section>
      <section class="split">
        <div>${umpiresHtml(live.boxscore.officials)}</div>
        <div>${standingsHtml(sides, standings)}</div>
      </section>
    </div>
    <div class="teams">${sides.map((s, i) => teamHtml(s, people, rankings, standings, startingPitcherSets[i], coachSets[i])).join('')}</div>
    <p class="muted no-print">Updated ${esc(new Date().toLocaleTimeString())}${isLive ? '. Refreshes every 5 minutes while the game is in progress.' : '.'}</p>`;
  statsNoteEl.textContent = `Stats: ${season} ${statsNote}. Batters with fewer than ${SMALL_SAMPLE_AB} AB show H/AB in place of AVG.`;
  const status = `<span class="status">${esc(gd.status.detailedState)}</span>`;
  navExtraEl.innerHTML = isPostseason ? `${status} · ${statToggleHtml(statType)}` : status;
  if (isPostseason) {
    navExtraEl.querySelector('select').addEventListener('change', e => {
      usePostseasonStats = e.target.value === 'P';
      route();
    });
  }

  if (isLive) refreshTimer = setTimeout(route, REFRESH_MS);
}

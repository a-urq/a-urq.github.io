import { Chess } from 'chess.js';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { PIECE_DEFS, PIECE_IDS } from './pieces.js';
import examplePgn from '../games/example-game.pgn';
import examplePgn2 from '../games/example-game-2.pgn';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const GAME_STORAGE_KEY = 'boardroom.importedPgnGames.v1';
const FILES = 'abcdefgh';
const CONTROL_COLORS = {
  uncontrolled: ['#c4bfb4', '#b3ada2'],
  white: ['#77b7e8', '#65a2d8'],
  black: ['#e88782', '#d87576'],
  contested: ['#b497db', '#a17fd0'],
};

const boardElement = document.querySelector('#board');
const fenInput = document.querySelector('#fenInput');
const fenError = document.querySelector('#fenError');
const boardCaption = document.querySelector('#boardCaption');
const exportButton = document.querySelector('#exportButton');
const exportResult = document.querySelector('#exportResult');
const gameSection = document.querySelector('#gameSection');
const gameSelect = document.querySelector('#gameSelect');
const moveList = document.querySelector('#moveList');
const pgnFileInput = document.querySelector('#pgnFileInput');
const pgnTextInput = document.querySelector('#pgnTextInput');
const pgnImportStatus = document.querySelector('#pgnImportStatus');
const exportDialog = document.querySelector('#exportDialog');
const exportGifButton = document.querySelector('#exportGifButton');
const controlChartPanel = document.querySelector('#controlChartPanel');
const controlChart = document.querySelector('#controlChart');
const controlChartLegend = document.querySelector('#controlChartLegend');
const controlChartReadout = document.querySelector('#controlChartReadout');

let orientation = 'white';
let replay = null;
let currentPly = 0;
let currentPosition = null;
let previewTimer;
let games = [];
let chartPointerId = null;

function parseFen(input) {
  const trimmed = input.trim() || START_FEN;
  const fields = trimmed.split(/\s+/);
  const placement = fields[0];
  if (fields.length === 1) fields.push('w', '-', '-', '0', '1');
  const ranks = placement.split('/');
  if (ranks.length !== 8) throw new Error('FEN must describe exactly eight ranks.');

  const squares = Array.from({ length: 8 }, () => Array(8).fill(null));
  ranks.forEach((rankText, row) => {
    let file = 0;
    for (const token of rankText) {
      if (/^[1-8]$/.test(token)) {
        file += Number(token);
      } else if (/^[prnbqkPRNBQK]$/.test(token)) {
        if (file >= 8) throw new Error(`Rank ${8 - row} contains too many squares.`);
        squares[row][file] = token;
        file += 1;
      } else {
        throw new Error(`Unexpected FEN piece or character: ${token}`);
      }
    }
    if (file !== 8) throw new Error(`Rank ${8 - row} must contain exactly eight squares.`);
  });

  return { placement, fen: fields.slice(0, 6).join(' '), squares };
}

function getPinConstraints(position) {
  const constraints = new Map();
  const directions = [
    [-1, -1], [-1, 0], [-1, 1], [0, -1],
    [0, 1], [1, -1], [1, 0], [1, 1],
  ];
  const kings = [];
  position.squares.forEach((rank, row) => rank.forEach((piece, file) => {
    if (piece?.toLowerCase() === 'k') kings.push({ row, file, color: piece === 'k' ? 'black' : 'white' });
  }));

  for (const king of kings) {
    for (const [dr, df] of directions) {
      let row = king.row + dr;
      let file = king.file + df;
      let candidate = null;
      while (row >= 0 && row < 8 && file >= 0 && file < 8) {
        const piece = position.squares[row][file];
        if (piece) {
          const color = piece === piece.toLowerCase() ? 'black' : 'white';
          if (!candidate) {
            if (color !== king.color) break;
            candidate = { row, file };
          } else {
            if (color !== king.color) {
              const type = piece.toLowerCase();
              const diagonal = dr !== 0 && df !== 0;
              const pinsOnRay = type === 'q' || (diagonal ? type === 'b' : type === 'r');
              if (pinsOnRay) constraints.set(`${candidate.row},${candidate.file}`, king);
            }
            break;
          }
        }
        row += dr;
        file += df;
      }
    }
  }
  return constraints;
}

function attacksFrom(position, row, file, piece, pinConstraints, { ignorePins = false, continueThroughKing = true } = {}) {
  const targets = [];
  const lower = piece.toLowerCase();
  const color = piece === lower ? 'black' : 'white';
  const add = (r, f) => {
    if (r >= 0 && r < 8 && f >= 0 && f < 8) targets.push([r, f]);
  };

  if (lower === 'p') {
    const direction = color === 'white' ? -1 : 1;
    add(row + direction, file - 1);
    add(row + direction, file + 1);
  } else if (lower === 'n') {
    for (const [dr, df] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]) add(row + dr, file + df);
  } else if (lower === 'k') {
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let df = -1; df <= 1; df += 1) {
        if (dr || df) add(row + dr, file + df);
      }
    }
  } else {
    const directions = [];
    if (lower === 'b' || lower === 'q') directions.push([-1, -1], [-1, 1], [1, -1], [1, 1]);
    if (lower === 'r' || lower === 'q') directions.push([-1, 0], [1, 0], [0, -1], [0, 1]);
    for (const [dr, df] of directions) {
      let r = row + dr;
      let f = file + df;
      while (r >= 0 && r < 8 && f >= 0 && f < 8) {
        targets.push([r, f]);
        const blocker = position.squares[r][f];
        if (blocker && (!continueThroughKing || blocker.toLowerCase() !== 'k')) break;
        r += dr;
        f += df;
      }
    }
  }
  const king = pinConstraints.get(`${row},${file}`);
  const legalTargets = king && !ignorePins
    ? targets.filter(([targetRow, targetFile]) => (targetRow - king.row) * (file - king.file) === (targetFile - king.file) * (row - king.row))
    : targets;
  return { color, targets: legalTargets };
}

function isSquareAttacked(position, targetRow, targetFile, byColor) {
  const noPinConstraints = new Map();
  return position.squares.some((rank, row) => rank.some((piece, file) => {
    if (!piece || (piece === piece.toLowerCase() ? 'black' : 'white') !== byColor) return false;
    const { targets } = attacksFrom(position, row, file, piece, noPinConstraints, {
      ignorePins: true,
      continueThroughKing: false,
    });
    return targets.some(([attackRow, attackFile]) => attackRow === targetRow && attackFile === targetFile);
  }));
}

function getControlMap(position) {
  const control = Array.from({ length: 8 }, () => Array(8).fill(0));
  const pinConstraints = getPinConstraints(position);
  position.squares.forEach((rank, row) => rank.forEach((piece, file) => {
    if (!piece) return;
    const { color, targets: attacks } = attacksFrom(position, row, file, piece, pinConstraints);
    let targets = attacks;
    if (piece.toLowerCase() === 'k') {
      targets = targets.filter(([targetRow, targetFile]) => {
        const squares = position.squares.map((currentRank) => currentRank.slice());
        squares[row][file] = null;
        const targetPiece = squares[targetRow][targetFile];
        if (targetPiece && (targetPiece === targetPiece.toLowerCase() ? 'black' : 'white') !== color) {
          squares[targetRow][targetFile] = null;
        }
        return !isSquareAttacked({ ...position, squares }, targetRow, targetFile, color === 'white' ? 'black' : 'white');
      });
    }
    for (const [r, f] of targets) control[r][f] |= color === 'white' ? 1 : 2;
  }));
  return control;
}

function countControlledSquares(position) {
  const counts = { white: 0, black: 0, contested: 0 };
  getControlMap(position).forEach((rank) => rank.forEach((value) => {
    if (value === 1) counts.white += 1;
    else if (value === 2) counts.black += 1;
    else if (value === 3) counts.contested += 1;
  }));
  return { ...counts, total: counts.white + counts.black + counts.contested };
}

function renderBoard(position) {
  boardElement.innerHTML = makeSvg(position);
}

function updateBoardCaption() {
  const side = `${orientation[0].toUpperCase()}${orientation.slice(1)} at bottom`;
  document.querySelector('#currentPositionTitle').textContent = replay ? gameMetadata(replay) : 'Current position';
  if (currentPly === null) boardCaption.textContent = `Custom position · ${side}`;
  else if (!replay || currentPly === 0) boardCaption.textContent = side;
  else boardCaption.textContent = `After ${replay.moves[currentPly - 1].label} · ${side}`;
}

function gameMetadata(game) {
  return [
    `${game.white} vs ${game.black}`,
    game.opening,
    game.date,
    game.result,
  ].filter(Boolean).join(' · ');
}

function updateReplayControls() {
  const count = replay?.moves.length || 0;
  document.querySelector('#moveCounter').textContent = currentPly === null
    ? 'CUSTOM POSITION'
    : currentPly === 0
      ? `START · ${count} PLYS`
      : `${currentPly} / ${count} · ${replay.moves[currentPly - 1].label}`;
  document.querySelector('#previousMoveButton').disabled = currentPly === null || currentPly <= 0;
  document.querySelector('#nextMoveButton').disabled = currentPly === null || currentPly >= count;
  document.querySelector('#startGameButton').disabled = !replay || currentPly === 0;
  document.querySelector('#endGameButton').disabled = !replay || currentPly === count;
  document.querySelectorAll('.move-cell').forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.ply) === currentPly);
  });
  updateControlChartCursor();
}

function updatePosition(input) {
  try {
    currentPosition = parseFen(input);
    renderBoard(currentPosition);
    fenError.hidden = true;
    exportButton.disabled = false;
    updateBoardCaption();
  } catch (error) {
    fenError.textContent = error.message;
    fenError.hidden = false;
    exportButton.disabled = true;
  }
}

function renderMoves(moves) {
  moveList.replaceChildren();
  const rows = new Map();
  moves.forEach((move) => {
    if (!rows.has(move.moveNumber)) {
      const row = document.createElement('div');
      row.className = 'move-row';
      const number = document.createElement('span');
      number.className = 'move-number';
      number.textContent = `${move.moveNumber}.`;
      row.append(number);
      rows.set(move.moveNumber, row);
      moveList.append(row);
    }
    const button = document.createElement('button');
    button.className = 'move-cell';
    button.type = 'button';
    button.dataset.ply = String(move.ply);
    button.textContent = move.san;
    button.title = move.label;
    button.setAttribute('aria-label', `Go to ${move.label}`);
    button.addEventListener('click', () => showPly(move.ply));
    rows.get(move.moveNumber).append(button);
  });
}

function loadPgnGame(id, pgn, fallbackName = 'PGN game') {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const history = chess.history({ verbose: true });
  const headers = chess.getHeaders();
  while (chess.undo()) { /* rewind to the starting position */ }
  const startingFen = chess.fen();
  const startingFields = startingFen.split(/\s+/);
  let moveNumber = Number(startingFields[5] || 1);
  let sideToMove = startingFields[1] === 'b' ? 'black' : 'white';
  const moves = history.map((move, index) => {
    const color = sideToMove;
    const currentMoveNumber = moveNumber;
    chess.move(move.san);
    const replayMove = {
      ply: index + 1,
      moveNumber: currentMoveNumber,
      san: move.san,
      label: color === 'white' ? `${currentMoveNumber}. ${move.san}` : `${currentMoveNumber}... ${move.san}`,
      fen: chess.fen(),
    };
    if (color === 'black') moveNumber += 1;
    sideToMove = color === 'white' ? 'black' : 'white';
    return replayMove;
  });
  const controlTimeline = [startingFen, ...moves.map((move) => move.fen)]
    .map((fen) => countControlledSquares(parseFen(fen)));
  return {
    id,
    pgn,
    name: fallbackName,
    white: headers.White || 'White',
    black: headers.Black || 'Black',
    date: headers.Date || 'Date unknown',
    result: headers.Result || '*',
    opening: headers.Opening || headers.ECO || '',
    event: headers.Event || fallbackName,
    startingFen,
    moves,
    controlTimeline,
  };
}

function renderControlChart() {
  if (!replay) {
    controlChartPanel.hidden = true;
    return;
  }

  controlChartPanel.hidden = false;
  controlChart.setAttribute('tabindex', '0');
  controlChart.setAttribute('aria-label', `Interactive square control chart; ${replay.moves.length} plies. Use left and right arrow keys to select a ply.`);
  const data = replay.controlTimeline;
  const width = 420;
  const height = 230;
  const left = 36;
  const right = 10;
  const top = 12;
  const bottom = 180;
  const plotWidth = width - left - right;
  const plotHeight = bottom - top;
  const x = (index) => left + (data.length > 1 ? index / (data.length - 1) : 0) * plotWidth;
  const percent = (item, key) => item.total ? item[key] / item.total * 100 : 0;
  const bottomKey = orientation === 'white' ? 'white' : 'black';
  const topKey = orientation === 'white' ? 'black' : 'white';
  const bottomValues = data.map((item) => percent(item, bottomKey));
  const contestedValues = data.map((item, index) => bottomValues[index] + percent(item, 'contested'));
  const zeroValues = data.map(() => 0);
  const fullValues = data.map(() => 100);
  const y = (value) => top + (100 - value) / 100 * plotHeight;
  const areaPath = (upper, lower) => {
    const upperPath = upper.map((value, index) => `${index ? 'L' : 'M'} ${x(index).toFixed(2)} ${y(value).toFixed(2)}`).join(' ');
    const lowerPath = lower.map((_, reverseIndex) => {
      const index = lower.length - reverseIndex - 1;
      return `L ${x(index).toFixed(2)} ${y(lower[index]).toFixed(2)}`;
    }).join(' ');
    return `${upperPath} ${lowerPath} Z`;
  };
  const grid = [0, 25, 50, 75, 100].map((value) => {
    const yPosition = y(value);
    return `<line class="chart-grid" x1="${left}" y1="${yPosition}" x2="${width - right}" y2="${yPosition}"/><text class="chart-axis-label" x="${left - 10}" y="${yPosition + 3}" text-anchor="end">${value}%</text>`;
  }).join('');
  const labels = [...new Set([0, Math.floor((data.length - 1) / 2), data.length - 1])].map((ply) => {
    const anchor = ply === 0 ? 'start' : ply === data.length - 1 ? 'end' : 'middle';
    return `<text class="chart-axis-label" x="${x(ply)}" y="${bottom + 20}" text-anchor="${anchor}">${ply}</text>`;
  }).join('');
  const seriesNames = { white: 'White', black: 'Black', contested: 'Contested' };
  const series = [
    { key: bottomKey, upper: bottomValues, lower: zeroValues },
    { key: 'contested', upper: contestedValues, lower: bottomValues },
    { key: topKey, upper: fullValues, lower: contestedValues },
  ];
  controlChartLegend.innerHTML = series.map(({ key }) => `<span><i class="${key}-control"></i>${seriesNames[key]}</span>`).join('');
  const cursorX = x(Math.max(0, currentPly || 0));
  const areas = series.map(({ key, upper, lower }) => `<path class="chart-area chart-area-${key}" d="${areaPath(upper, lower)}"/>`).join('');
  controlChart.innerHTML = `${grid}${areas}<line class="chart-grid" x1="${left}" y1="${bottom}" x2="${width - right}" y2="${bottom}"/><text class="chart-axis-label" x="${left + plotWidth / 2}" y="${height - 4}" text-anchor="middle">Ply (half-moves)</text>${labels}<g class="chart-cursor" id="chartCursor" transform="translate(${cursorX} 0)"><line x1="0" y1="${top}" x2="0" y2="${bottom}"/></g>`;
  updateControlChartCursor();
}

function updateControlChartCursor() {
  if (!replay || controlChartPanel.hidden) return;
  const cursor = controlChart.querySelector('#chartCursor');
  const data = replay.controlTimeline;
  if (!cursor || !data.length) return;
  if (currentPly === null) {
    cursor.setAttribute('visibility', 'hidden');
    controlChartReadout.textContent = 'Custom position · not on the selected game timeline';
    return;
  }

  const ply = Math.max(0, Math.min(currentPly, data.length - 1));
  const left = 36;
  const plotWidth = 420 - left - 10;
  const x = left + (data.length > 1 ? ply / (data.length - 1) : 0) * plotWidth;
  const item = data[ply];
  cursor.setAttribute('transform', `translate(${x} 0)`);
  cursor.setAttribute('visibility', 'visible');
  const label = ply === 0 ? 'Starting position' : `After ${replay.moves[ply - 1].label}`;
  controlChartReadout.textContent = `${label} · White ${item.white} · Black ${item.black} · Contested ${item.contested} · ${item.total} controlled squares`;
}

function selectPlyFromChartPointer(event) {
  if (!replay || !event.isPrimary && event.type === 'pointerdown') return;
  const bounds = controlChart.getBoundingClientRect();
  if (!bounds.width || !replay.moves.length) return;
  const viewX = (event.clientX - bounds.left) / bounds.width * 420;
  const plotStart = 36;
  const plotWidth = 420 - plotStart - 10;
  const ratio = Math.max(0, Math.min(1, (viewX - plotStart) / plotWidth));
  showPly(Math.round(ratio * replay.moves.length));
}

controlChart.addEventListener('pointerdown', (event) => {
  if (!replay || !event.isPrimary || event.button !== 0) return;
  chartPointerId = event.pointerId;
  controlChart.setPointerCapture(event.pointerId);
  selectPlyFromChartPointer(event);
  event.preventDefault();
});
controlChart.addEventListener('pointermove', (event) => {
  if (chartPointerId !== event.pointerId) return;
  selectPlyFromChartPointer(event);
});
controlChart.addEventListener('pointerup', (event) => {
  if (chartPointerId === event.pointerId) chartPointerId = null;
});
controlChart.addEventListener('pointercancel', () => { chartPointerId = null; });
controlChart.addEventListener('lostpointercapture', () => { chartPointerId = null; });
controlChart.addEventListener('keydown', (event) => {
  if (!replay || currentPly === null) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    if (event.key === 'Home') showPly(0);
    else if (event.key === 'End') showPly(replay.moves.length);
    else showPly(currentPly + (event.key === 'ArrowRight' ? 1 : -1));
  }
});

function showPly(ply) {
  if (!replay) return;
  currentPly = Math.max(0, Math.min(ply, replay.moves.length));
  fenInput.value = currentPly === 0 ? replay.startingFen : replay.moves[currentPly - 1].fen;
  updatePosition(fenInput.value);
  updateReplayControls();
}

function displayGame(game) {
  replay = game;
  currentPly = 0;
  renderControlChart();
  document.querySelector('#gameSummary').textContent = [game.event, game.date, game.opening, game.result].filter(Boolean).join(' · ');
  renderMoves(game.moves);
  showPly(0);
}

function readStoredGames() {
  try {
    const saved = JSON.parse(localStorage.getItem(GAME_STORAGE_KEY) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function persistImportedGame(game) {
  const saved = readStoredGames().filter((item) => item.id !== game.id);
  saved.unshift({ id: game.id, pgn: game.pgn, name: game.name });
  localStorage.setItem(GAME_STORAGE_KEY, JSON.stringify(saved.slice(0, 20)));
}

function refreshGamePicker(selectId = '') {
  const selected = games.find((game) => game.id === selectId);
  gameSelect.replaceChildren();
  games.forEach((game) => {
    const option = document.createElement('option');
    option.value = game.id;
    option.textContent = `${game.white} vs ${game.black} · ${game.date} · ${game.result}`;
    gameSelect.append(option);
  });
  gameSection.hidden = games.length === 0;
  if (selected) gameSelect.value = selected.id;
}

function initializeGames() {
  const defaultGames = [];
  try {
    defaultGames.push(loadPgnGame('example-game.pgn', examplePgn, 'Example Lichess game'));
  } catch { /* The starting board remains useful if the bundled example is invalid. */ }
  try {
    defaultGames.push(loadPgnGame('example-game-2.pgn', examplePgn2, 'Example Lichess game 2'));
  } catch { /* Keep the first default game available if this example is invalid. */ }

  const storedGames = [];
  for (const saved of readStoredGames()) {
    try { storedGames.push(loadPgnGame(saved.id, saved.pgn, saved.name)); }
    catch { /* Ignore stored games that are no longer parseable. */ }
  }
  games = [...defaultGames, ...storedGames.filter((game) => !defaultGames.some((defaultGame) => game.id === defaultGame.id))];
  const initialGame = defaultGames[0] || storedGames[0] || null;
  refreshGamePicker(initialGame?.id || '');
  if (initialGame) displayGame(initialGame);
}

function escapeXml(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

function makeSvg(position) {
  const squareSize = 80;
  const margin = 30;
  const size = squareSize * 8;
  const control = getControlMap(position);
  const ranks = orientation === 'white' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const files = orientation === 'white' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size + margin * 2} ${size + margin * 2}" role="img" aria-label="Chess position board">`, '<defs>', PIECE_DEFS, '</defs>', '<rect width="100%" height="100%" fill="#101914"/>'];
  ranks.forEach((rank, displayRow) => files.forEach((file, displayColumn) => {
    const value = control[rank][file];
    const key = value === 3 ? 'contested' : value === 1 ? 'white' : value === 2 ? 'black' : 'uncontrolled';
    const isLight = (rank + file) % 2 === 1;
    const x = margin + displayColumn * squareSize;
    const y = margin + displayRow * squareSize;
    parts.push(`<rect x="${x}" y="${y}" width="${squareSize}" height="${squareSize}" fill="${CONTROL_COLORS[key][isLight ? 0 : 1]}"/>`);
    const piece = position.squares[rank][file];
    if (piece) {
      parts.push(`<g transform="translate(${x} ${y}) scale(${squareSize / 45})"><use href="#${PIECE_IDS[piece]}"/></g>`);
    }
    if (displayColumn === 0) parts.push(`<text x="${x + 4}" y="${y + 14}" font-family="monospace" font-size="11" fill="#18211c">${8 - rank}</text>`);
    if (displayRow === 7) parts.push(`<text x="${x + squareSize - 12}" y="${y + squareSize - 4}" font-family="monospace" font-size="11" fill="#18211c">${FILES[file]}</text>`);
  }));
  parts.push('</svg>');
  return parts.join('');
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportMetadata(game = replay) {
  if (!game) return { title: 'Chess position', detail: 'Custom FEN position' };
  return {
    title: `${game.white} vs ${game.black}`,
    detail: [game.event, game.opening, game.date, game.result].filter(Boolean).join(' · '),
  };
}

function makeExportSvg(position, metadata, moveLabel) {
  const boardSvg = makeSvg(position)
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>$/, '')
    .replace('<rect width="100%" height="100%" fill="#101914"/>', '');
  const details = exportMetadata(metadata);
  const compact = (value) => value.length > 86 ? `${value.slice(0, 83)}…` : value;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="780" viewBox="0 0 760 780" role="img" aria-label="Chess position: ${escapeXml(details.title)}"><rect width="760" height="780" fill="#101914"/><text x="30" y="25" fill="#eef3ed" font-family="system-ui,sans-serif" font-size="16" font-weight="600">${escapeXml(compact(details.title))}</text><text x="30" y="45" fill="#b6c8b9" font-family="system-ui,sans-serif" font-size="11">${escapeXml(compact(details.detail))}</text><text x="30" y="65" fill="#9aa99b" font-family="system-ui,sans-serif" font-size="11">${escapeXml(compact(moveLabel))}</text><g transform="translate(0 75)">${boardSvg}</g></svg>`;
}

function rasterizeSvg(svg, width = 760, height = 780) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      context.fillStyle = '#101914';
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      resolve(canvas);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not render the chess image.'));
    };
    image.src = url;
  });
}

function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not create the PNG image.')), 'image/png');
  });
}

function exportCurrentPosition() {
  if (!currentPosition) return;
  exportDialog.returnValue = '';
  exportGifButton.disabled = !replay;
  exportDialog.showModal();
}

async function exportPng() {
  const positionLabel = replay && currentPly !== null && currentPly > 0
    ? `After ${replay.moves[currentPly - 1].label}`
    : replay ? 'Starting position' : 'Current FEN position';
  exportResult.textContent = 'Preparing PNG…';
  exportResult.hidden = false;
  try {
    const canvas = await rasterizeSvg(makeExportSvg(currentPosition, replay, positionLabel));
    const png = await canvasToPng(canvas);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(`chess-position-${stamp}.png`, png);
    exportResult.textContent = `PNG ready: chess-position-${stamp}.png`;
  } catch (error) {
    exportResult.textContent = error.message || 'PNG export failed.';
  }
}

async function exportGif() {
  if (!replay) return;
  const gifWidth = 560;
  const gifHeight = 575;
  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = gifWidth;
  frameCanvas.height = gifHeight;
  const context = frameCanvas.getContext('2d', { willReadFrequently: true });
  const frames = [
    { fen: replay.startingFen, label: 'Starting position' },
    ...replay.moves.map((move) => ({ fen: move.fen, label: `After ${move.label}` })),
  ];
  const gif = GIFEncoder();
  let palette;
  exportResult.hidden = false;
  try {
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index];
      const position = parseFen(frame.fen);
      const canvas = await rasterizeSvg(makeExportSvg(position, replay, frame.label), gifWidth, gifHeight);
      context.drawImage(canvas, 0, 0, gifWidth, gifHeight);
      const pixels = context.getImageData(0, 0, gifWidth, gifHeight).data;
      if (!palette) palette = quantize(pixels, 256);
      const indexedPixels = applyPalette(pixels, palette);
      gif.writeFrame(indexedPixels, gifWidth, gifHeight, {
        ...(index === 0 ? { palette, repeat: 0 } : {}),
        delay: index === 0 ? 500 : index === frames.length - 1 ? 1200 : 140,
      });
      exportResult.textContent = `Building GIF… ${index + 1} / ${frames.length} frames`;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    gif.finish();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadBlob(`chess-game-${stamp}.gif`, new Blob([gif.bytes()], { type: 'image/gif' }));
    exportResult.textContent = `GIF ready: chess-game-${stamp}.gif (${frames.length} frames)`;
  } catch (error) {
    exportResult.textContent = error.message || 'GIF export failed.';
  }
}

function setImportStatus(message, isError = false) {
  pgnImportStatus.textContent = message;
  pgnImportStatus.classList.toggle('error', isError);
  pgnImportStatus.hidden = false;
}

async function importPgn(text, name) {
  if (!text.trim()) throw new Error('Choose a PGN file or paste PGN text first.');
  if (text.length > 1024 * 1024) throw new Error('PGN must be smaller than 1 MB.');
  const id = `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const game = loadPgnGame(id, text, name);
  if (!game.moves.length) throw new Error('No moves found in that PGN.');
  persistImportedGame(game);
  games = [game, ...games.filter((item) => item.id !== game.id)];
  refreshGamePicker(game.id);
  displayGame(game);
  setImportStatus(`Imported “${game.white} vs ${game.black}” and saved it in this browser.`);
}

fenInput.addEventListener('input', () => {
  if (replay && currentPly !== null) {
    const expected = currentPly === 0 ? replay.startingFen : replay.moves[currentPly - 1]?.fen;
    if (fenInput.value !== expected) {
      currentPly = null;
      updateReplayControls();
    }
  }
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => updatePosition(fenInput.value), 180);
});

document.querySelector('#orientationButton').addEventListener('click', () => {
  orientation = orientation === 'white' ? 'black' : 'white';
  document.querySelector('#orientationButton').setAttribute('aria-label', `Flip board orientation; ${orientation} is at bottom`);
  if (currentPosition) renderBoard(currentPosition);
  renderControlChart();
  updateBoardCaption();
});

document.querySelector('#resetButton').addEventListener('click', () => {
  replay = null;
  currentPly = null;
  renderControlChart();
  fenInput.value = START_FEN;
  updatePosition(fenInput.value);
  updateReplayControls();
});

gameSelect.addEventListener('change', () => {
  const game = games.find((item) => item.id === gameSelect.value);
  if (game) displayGame(game);
});
document.querySelector('#startGameButton').addEventListener('click', () => showPly(0));
document.querySelector('#previousMoveButton').addEventListener('click', () => showPly(currentPly - 1));
document.querySelector('#nextMoveButton').addEventListener('click', () => showPly(currentPly + 1));
document.querySelector('#endGameButton').addEventListener('click', () => showPly(replay?.moves.length || 0));

document.querySelector('#uploadPgnButton').addEventListener('click', () => pgnFileInput.click());
pgnFileInput.addEventListener('change', async () => {
  const file = pgnFileInput.files?.[0];
  if (!file) return;
  try {
    setImportStatus('Reading PGN…');
    await importPgn(await file.text(), file.name);
  } catch (error) {
    setImportStatus(error.message || 'Could not import PGN.', true);
  } finally {
    pgnFileInput.value = '';
  }
});
document.querySelector('#importPgnButton').addEventListener('click', async () => {
  try {
    setImportStatus('Importing PGN…');
    await importPgn(pgnTextInput.value, 'Pasted Lichess game');
    pgnTextInput.value = '';
  } catch (error) {
    setImportStatus(error.message || 'Could not import PGN.', true);
  }
});
exportButton.addEventListener('click', exportCurrentPosition);
exportDialog.addEventListener('close', () => {
  if (exportDialog.returnValue === 'png') exportPng();
  if (exportDialog.returnValue === 'gif') exportGif();
});

fenInput.value = START_FEN;
updatePosition(fenInput.value);
initializeGames();

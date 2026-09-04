'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import {
  Activity, AlertTriangle, Bot, CircleHelp, Download, Droplets, Flame, History,
  Languages, LockKeyhole, MoveRight, Play, Power, Radio, RotateCcw, ShieldCheck,
  Timer, Wrench, Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  createInitialGame, createRunReport, downloadReplay, INCIDENT_DEFS, loadReplayIndex,
  reduceGame, ROOM_CONNECTIONS, saveReplay, TOOL_DEFS,
  type DroneId, type GameAction, type GameState, type IncidentKind, type Locale,
  type RoomId, type RoomKind, type RunMode, type ToolId,
} from '@/lib/game/index.ts';

const ROOM_VISUAL: Record<RoomId, { x: number; y: number; w: number; h: number }> = {
  'A-01': { x: 18, y: 20, w: 178, h: 116 },
  'A-02': { x: 214, y: 20, w: 146, h: 116 },
  'B-03': { x: 378, y: 20, w: 172, h: 116 },
  'B-04': { x: 18, y: 154, w: 214, h: 130 },
  'C-05': { x: 250, y: 154, w: 144, h: 130 },
  'C-06': { x: 412, y: 154, w: 138, h: 130 },
};

const ROOM_LABELS: Record<RoomKind, { ko: string; en: string }> = {
  dock: { ko: '도킹 베이', en: 'Docking bay' }, medbay: { ko: '의무실', en: 'Medbay' },
  hydro: { ko: '수경 재배', en: 'Hydroponics' }, coolant: { ko: '냉각실', en: 'Coolant' },
  power: { ko: '전력 허브', en: 'Power hub' }, lab: { ko: '연구동', en: 'Research lab' },
};

const INCIDENT_LABELS: Record<IncidentKind, { ko: string; en: string; code: string }> = {
  leak: { ko: '냉각수 누출', en: 'Coolant leak', code: 'LEAK' },
  fire: { ko: '화재 감지', en: 'Fire detected', code: 'FIRE' },
  arc: { ko: '전기 아크', en: 'Electrical arc', code: 'ARC' },
  door: { ko: '출입문 고장', en: 'Door jam', code: 'DOOR' },
};

const COPY = {
  ko: { start: '평가 시작', newRun: '새 평가', briefing: '관제 교대 브리핑', briefingBody: '경보를 읽고, 드론을 한 구역씩 이동시킨 뒤 올바른 안전 절차와 도구로 모든 사고를 해결하세요.', incidentQueue: '경보 큐', stationMap: '정거장 지도', console: '제어 콘솔', powerGrid: '전력망', drones: '드론', comms: '통신·로그', move: '선택 구역 이동', wait: '1틱 대기', result: '평가 결과', help: '조작 안내', history: '최근 기록', selectedTarget: '선택 대상', toolbelt: '도구 벨트 · 클릭 또는 지도에 드래그', instruction: '현재 지시', restore: '전원 복구', cut: '전원 차단' },
  en: { start: 'Start evaluation', newRun: 'New run', briefing: 'Shift briefing', briefingBody: 'Read alerts, move a drone one room at a time, and resolve every incident with the correct safety procedure and tool.', incidentQueue: 'Incident queue', stationMap: 'Station map', console: 'Control console', powerGrid: 'Power grid', drones: 'Drones', comms: 'Comms & log', move: 'Move to selection', wait: 'Wait 1 tick', result: 'Run report', help: 'Controls', history: 'Recent runs', selectedTarget: 'Selected target', toolbelt: 'Toolbelt · click or drag onto map', instruction: 'Current directive', restore: 'Restore power', cut: 'Cut power' },
} as const;

type ConsoleTab = 'power' | 'drones' | 'log';
type LayoutProfile = 'A' | 'B';

export default function Home() {
  const [game, setGame] = useState(() => createInitialGame());
  const [selectedRoom, setSelectedRoom] = useState<RoomId>(game.incidents[0].roomId);
  const [selectedDrone, setSelectedDrone] = useState<DroneId>('PATCH-01');
  const [selectedIncident, setSelectedIncident] = useState('INC-01');
  const [activeTab, setActiveTab] = useState<ConsoleTab>('power');
  const [layoutProfile, setLayoutProfile] = useState<LayoutProfile>('A');
  const [helpOpen, setHelpOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const savedRun = useRef<string | null>(null);
  const t = COPY[game.config.locale];

  const activeIncidents = useMemo(() => game.incidents.filter((item) => item.status === 'active').sort((a, b) => b.severity - a.severity || a.id.localeCompare(b.id)), [game.incidents]);
  const selectedIncidentState = game.incidents.find((item) => item.id === selectedIncident);
  const selectedRoomState = game.rooms.find((room) => room.id === selectedRoom) ?? game.rooms[0];
  const report = useMemo(() => createRunReport(game), [game]);
  const replayIndex = historyOpen ? loadReplayIndex() : [];

  const dispatchGame = useCallback((action: GameAction) => setGame((current) => reduceGame(current, action)), []);

  useEffect(() => {
    if (selectedIncidentState?.status === 'active') return;
    const next = activeIncidents[0];
    if (next) { setSelectedIncident(next.id); setSelectedRoom(next.roomId); }
  }, [activeIncidents, selectedIncidentState?.status]);

  useEffect(() => {
    if (game.phase !== 'won' && game.phase !== 'lost') return;
    setResultOpen(true);
    if (savedRun.current !== game.runId) { saveReplay(game); savedRun.current = game.runId; }
  }, [game]);

  useEffect(() => {
    if (game.phase !== 'active' || game.config.mode !== 'realtime') return;
    const interval = window.setInterval(() => dispatchGame({ type: 'WAIT' }), 2500);
    return () => window.clearInterval(interval);
  }, [dispatchGame, game.config.mode, game.phase]);

  function resetRun(seed = game.config.seed, overrides: { mode?: RunMode; locale?: Locale; layout?: LayoutProfile } = {}) {
    const layout = overrides.layout ?? layoutProfile;
    const nextGame = createInitialGame({ seed, layoutSeed: layout === 'A' ? 14 : 29, mode: overrides.mode ?? game.config.mode, locale: overrides.locale ?? game.config.locale });
    setLayoutProfile(layout);
    setGame(nextGame);
    setSelectedIncident('INC-01'); setSelectedRoom(nextGame.incidents[0].roomId); setSelectedDrone('PATCH-01'); setActiveTab('power');
    setResultOpen(false); savedRun.current = null;
  }

  function useTool(toolId: ToolId, roomId?: RoomId) {
    const incident = roomId ? game.incidents.find((item) => item.roomId === roomId && item.status === 'active') : game.incidents.find((item) => item.id === selectedIncident);
    dispatchGame({ type: 'USE_TOOL', droneId: selectedDrone, toolId, incidentId: incident?.id ?? selectedIncident });
  }

  function onDrop(event: DragEvent<SVGGElement>, roomId: RoomId) {
    event.preventDefault();
    const toolId = event.dataTransfer.getData('application/x-shift-tool') as ToolId;
    if (toolId) useTool(toolId, roomId);
  }

  const directive = getDirective(game, selectedDrone, selectedIncident);

  return (
    <main className={`game-shell min-h-screen px-3 py-3 text-[#e8f4f5] lg:px-4 ${layoutProfile === 'B' ? 'layout-b' : ''}`}>
      <header className="command-header panel-frame mb-3 flex min-h-16 items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="brand-mark" aria-hidden="true"><Activity size={19} /></div>
          <div className="min-w-0"><p className="eyebrow">ORBITAL EMERGENCY NETWORK · ARK-7</p><h1 className="truncate text-lg font-semibold tracking-[.08em]">SHIFT//RESCUE</h1></div>
        </div>
        <div className="hidden items-center gap-4 xl:flex">
          <span className="system-tag"><ShieldCheck size={13} />PIXEL INPUT ONLY</span>
          <span className="flex items-center gap-2 text-xs font-semibold tracking-[.14em] text-[#9fb4bb]"><span className="status-dot" />{game.config.mode.toUpperCase()} · TICK {String(game.tick).padStart(3, '0')}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="icon-lg" className="icon-command" onClick={() => setHistoryOpen(true)} aria-label={t.history}><History /></Button>
          <Button variant="ghost" size="icon-lg" className="icon-command" onClick={() => setHelpOpen(true)} aria-label={t.help}><CircleHelp /></Button>
          <Button className="start-button h-10 px-4" onClick={() => game.phase === 'briefing' ? dispatchGame({ type: 'START' }) : resetRun(game.config.seed + 1)}>
            {game.phase === 'briefing' ? <Play /> : <RotateCcw />}{game.phase === 'briefing' ? t.start : t.newRun}
          </Button>
        </div>
      </header>

      <section className="status-strip mb-3 grid grid-cols-2 gap-px overflow-hidden md:grid-cols-5">
        <StatusCell label={game.config.locale === 'ko' ? '선체' : 'HULL'} value={`${game.resources.hull}%`} tone={game.resources.hull < 45 ? 'red' : 'cyan'} />
        <StatusCell label={game.config.locale === 'ko' ? '산소' : 'OXYGEN'} value={`${game.resources.oxygen}%`} tone={game.resources.oxygen < 45 ? 'red' : 'cyan'} />
        <StatusCell label={game.config.locale === 'ko' ? '전력' : 'ENERGY'} value={`${game.resources.energy}%`} tone={game.resources.energy < 45 ? 'red' : 'amber'} />
        <StatusCell label={game.config.locale === 'ko' ? '구조 점수' : 'SCORE'} value={report.score.total.toLocaleString()} tone="white" />
        <StatusCell label={game.config.locale === 'ko' ? '남은 행동' : 'ACTIONS LEFT'} value={String(Math.max(0, game.config.tickLimit - game.tick))} tone="red" />
      </section>

      <section className="command-grid">
        <aside className="incident-panel panel-frame flex min-h-0 flex-col p-3">
          <PanelHeading icon={<AlertTriangle size={15} />} title={t.incidentQueue} meta={`${activeIncidents.length.toString().padStart(2, '0')} ACTIVE`} />
          <div className="mt-3 space-y-2 overflow-auto pr-1">
            {game.incidents.map((incident) => <AlertCard key={incident.id} locale={game.config.locale} incident={incident} selected={selectedIncident === incident.id} onClick={() => { setSelectedIncident(incident.id); setSelectedRoom(incident.roomId); }} />)}
          </div>
          <div className="mission-note mt-auto pt-3"><span>{t.instruction}</span><strong>{directive}</strong></div>
        </aside>

        <section className="map-panel panel-frame relative flex min-h-[430px] flex-col overflow-hidden p-3">
          <PanelHeading icon={<Activity size={15} />} title={t.stationMap} meta={`SELECTED ${selectedRoom}`} />
          <div className="map-grid relative mt-3 min-h-[350px] flex-1 overflow-hidden rounded-sm">
            <svg viewBox="0 0 568 304" className="h-full w-full" role="grid" aria-label="ARK-7 station map">
              <path d="M196 78H214M360 78H378M232 219H250M394 219H412M100 136V154M294 136V154M481 136V154" className="map-link" />
              {game.rooms.map((room) => {
                const box = ROOM_VISUAL[room.id];
                const incidents = game.incidents.filter((item) => item.roomId === room.id && item.status === 'active');
                const blocked = incidents.some((item) => item.kind === 'door');
                const drones = (Object.keys(game.drones) as DroneId[]).filter((id) => game.drones[id].roomId === room.id);
                const selected = selectedRoom === room.id;
                return <g key={room.id} role="gridcell" tabIndex={selected ? 0 : -1} aria-label={`${room.id}, ${ROOM_LABELS[room.kind][game.config.locale]}, ${incidents.length} incidents`} data-room-id={room.id} className="map-room cursor-pointer" onClick={() => setSelectedRoom(room.id)} onKeyDown={(event: KeyboardEvent<SVGGElement>) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedRoom(room.id); } }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => onDrop(event, room.id)}>
                  <rect x={box.x} y={box.y} width={box.w} height={box.h} rx="3" className={`room-surface ${selected ? 'room-selected' : ''} ${!room.powered ? 'room-unpowered' : ''} ${blocked ? 'room-blocked' : ''}`} />
                  <path d={`M${box.x + 7} ${box.y + 15}V${box.y + 7}H${box.x + 15} M${box.x + box.w - 15} ${box.y + 7}H${box.x + box.w - 7}V${box.y + 15}`} className="corner-mark" />
                  <text x={box.x + 13} y={box.y + 24} className="room-code">{room.id}</text>
                  <text x={box.x + 13} y={box.y + 45} className="room-name">{ROOM_LABELS[room.kind][game.config.locale]}</text>
                  {!room.powered && <text x={box.x + box.w - 13} y={box.y + 24} textAnchor="end" className="power-off-label">PWR OFF</text>}
                  {incidents.map((incident, index) => <IncidentGlyph key={incident.id} kind={incident.kind} x={box.x + box.w - 34 - index * 30} y={box.y + box.h - 30} />)}
                  {drones.map((id, index) => <DroneGlyph key={id} id={id} x={box.x + 28 + index * 46} y={box.y + box.h - 28} selected={id === selectedDrone} />)}
                </g>;
              })}
            </svg>
            <div className="map-legend absolute bottom-3 left-3 flex flex-wrap gap-3"><span><i className="bg-[#65e3cf]" />DRONE</span><span><i className="bg-[#69d6eb]" />LEAK</span><span><i className="bg-[#f0ae57]" />ALERT</span><span><i className="bg-[#ff747b]" />DANGER</span></div>
          </div>
          <div className="map-actions mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#20333b] pt-3">
            <div className="flex items-center gap-2 text-xs text-[#93a8af]"><Bot size={15} /><span>{selectedDrone} · {game.drones[selectedDrone].roomId} · BAT {game.drones[selectedDrone].battery}%</span></div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" className="control-button" disabled={game.phase !== 'active'} onClick={() => dispatchGame({ type: 'WAIT' })}><Timer />{t.wait}</Button>
              <Button className="execute-button" disabled={game.phase !== 'active' || game.drones[selectedDrone].roomId === selectedRoom} onClick={() => dispatchGame({ type: 'MOVE_DRONE', droneId: selectedDrone, to: selectedRoom })}><MoveRight />{t.move}</Button>
            </div>
          </div>
        </section>

        <aside className="console-panel panel-frame flex min-h-0 flex-col p-3">
          <PanelHeading icon={<Zap size={15} />} title={t.console} meta={activeTab.toUpperCase()} />
          <div className="mt-3 grid grid-cols-3 gap-1 rounded-sm bg-[#0a1217] p-1 text-[10px] font-semibold tracking-wider" role="tablist">
            {(['power', 'drones', 'log'] as ConsoleTab[]).map((tab) => <button key={tab} className={`console-tab ${activeTab === tab ? 'active' : ''}`} onClick={() => setActiveTab(tab)} role="tab" aria-selected={activeTab === tab}>{tab === 'power' ? t.powerGrid : tab === 'drones' ? t.drones : t.comms}</button>)}
          </div>
          {activeTab === 'power' && <PowerConsole game={game} locale={game.config.locale} selectedRoom={selectedRoom} setSelectedRoom={setSelectedRoom} dispatchGame={dispatchGame} labels={t} />}
          {activeTab === 'drones' && <DroneConsole game={game} locale={game.config.locale} selectedDrone={selectedDrone} setSelectedDrone={setSelectedDrone} />}
          {activeTab === 'log' && <EventLog game={game} locale={game.config.locale} />}
          <div className="console-card mt-auto">
            <div className="flex items-start justify-between gap-3"><div><p className="eyebrow">{t.selectedTarget}</p><h2 className="mt-1 font-semibold">{selectedRoom} · {ROOM_LABELS[selectedRoomState.kind][game.config.locale]}</h2></div><span className={`tiny-chip ${selectedRoomState.powered ? '' : 'warning'}`}>{selectedRoomState.powered ? 'ONLINE' : 'PWR OFF'}</span></div>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs"><div><dt>{game.config.locale === 'ko' ? '연결 구역' : 'Links'}</dt><dd>{ROOM_CONNECTIONS[selectedRoom].length}</dd></div><div><dt>{game.config.locale === 'ko' ? '사고' : 'Incidents'}</dt><dd className={activeIncidents.some((item) => item.roomId === selectedRoom) ? 'text-[#ff747b]' : ''}>{activeIncidents.filter((item) => item.roomId === selectedRoom).length}</dd></div></dl>
          </div>
        </aside>

        <footer className="tool-panel panel-frame p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><p className="eyebrow">{t.toolbelt}</p><p className="mt-1 text-xs text-[#89a0a7]">{game.config.locale === 'ko' ? '선택한 드론이 작업 범위에 있어야 합니다.' : 'The selected drone must be in work range.'}</p></div>
            <div className="flex flex-wrap gap-2">{(Object.keys(TOOL_DEFS) as ToolId[]).map((toolId) => <ToolButton key={toolId} toolId={toolId} locale={game.config.locale} count={game.inventory[toolId]} disabled={game.phase !== 'active'} onUse={() => useTool(toolId)} />)}</div>
          </div>
        </footer>
      </section>
      <div className="sr-only" aria-live="polite">{game.log.at(-1)?.message}</div>

      <BriefingDialog game={game} layoutProfile={layoutProfile} resetRun={resetRun} dispatchGame={dispatchGame} />
      <ResultDialog game={game} open={resultOpen} setOpen={setResultOpen} resetRun={resetRun} />
      <InfoDialogs game={game} helpOpen={helpOpen} setHelpOpen={setHelpOpen} historyOpen={historyOpen} setHistoryOpen={setHistoryOpen} replayIndex={replayIndex} />
    </main>
  );
}

function PowerConsole({ game, locale, selectedRoom, setSelectedRoom, dispatchGame, labels }: { game: GameState; locale: Locale; selectedRoom: RoomId; setSelectedRoom: (id: RoomId) => void; dispatchGame: (action: GameAction) => void; labels: typeof COPY.ko | typeof COPY.en }) {
  return <div className="mt-3 space-y-2 overflow-auto">{game.rooms.map((room) => <div key={room.id} className={`power-row ${selectedRoom === room.id ? 'selected' : ''}`}><button className="mb-2 flex w-full items-center justify-between gap-2 text-left text-xs" onClick={() => setSelectedRoom(room.id)}><span>{room.id} · {ROOM_LABELS[room.kind][locale]}</span><strong className={room.powered ? 'text-[#65e3cf]' : 'text-[#f0ae57]'}>{room.powered ? 'ON' : 'OFF'}</strong></button><Button variant="outline" className="power-toggle" disabled={game.phase !== 'active'} onClick={() => dispatchGame({ type: 'TOGGLE_POWER', roomId: room.id })}><Power />{room.powered ? labels.cut : labels.restore}</Button></div>)}</div>;
}

function DroneConsole({ game, locale, selectedDrone, setSelectedDrone }: { game: GameState; locale: Locale; selectedDrone: DroneId; setSelectedDrone: (id: DroneId) => void }) {
  return <div className="mt-3 space-y-2">{(Object.keys(game.drones) as DroneId[]).map((id) => { const drone = game.drones[id]; return <button key={id} className={`drone-card ${selectedDrone === id ? 'selected' : ''}`} onClick={() => setSelectedDrone(id)}><span className="drone-avatar"><Bot /></span><span><strong>{id}</strong><small>{drone.roomId} · BAT {drone.battery}%</small><em>{drone.specialty.map((kind) => INCIDENT_LABELS[kind].code).join(' / ')}</em></span></button>; })}<div className="console-hint"><Radio />{locale === 'ko' ? '드론을 선택하고 지도에서 인접한 구역을 지정하세요.' : 'Select a drone, then choose an adjacent room.'}</div></div>;
}

function EventLog({ game, locale }: { game: GameState; locale: Locale }) {
  return <div className="event-log mt-3 flex-1 overflow-auto" aria-live="polite">{game.log.length === 0 && <p>{locale === 'ko' ? '아직 기록된 행동이 없습니다.' : 'No actions recorded yet.'}</p>}{[...game.log].reverse().map((entry) => <div key={entry.seq} className={entry.accepted ? '' : 'error'}><span>{String(entry.seq + 1).padStart(2, '0')} / T{String(entry.tickAfter).padStart(2, '0')}</span><p>{entry.message}</p><code>{entry.stateHashAfter}</code></div>)}</div>;
}

function BriefingDialog({ game, layoutProfile, resetRun, dispatchGame }: { game: GameState; layoutProfile: LayoutProfile; resetRun: (seed?: number, overrides?: { mode?: RunMode; locale?: Locale; layout?: LayoutProfile }) => void; dispatchGame: (action: GameAction) => void }) {
  const t = COPY[game.config.locale];
  return <Modal open={game.phase === 'briefing'} eyebrow={`EVALUATION SEED ${game.config.seed} · LAYOUT ${layoutProfile}`} title={t.briefing} description={t.briefingBody} footer={<Button className="start-button h-11 px-6" onClick={() => dispatchGame({ type: 'START' })}><Play />{t.start}</Button>}><div className="briefing-grid"><BriefItem icon={<Languages />} title="OCR + ICON" detail={game.config.locale === 'ko' ? '문자, 숫자, 위험 기호 판독' : 'Read text, numbers and hazard marks'} /><BriefItem icon={<MoveRight />} title="SPATIAL" detail={game.config.locale === 'ko' ? '인접 구역을 따라 드론 이동' : 'Move through adjacent rooms'} /><BriefItem icon={<LockKeyhole />} title="SAFETY" detail={game.config.locale === 'ko' ? '아크·누출 전원 차단' : 'Cut power before risky repairs'} /></div><div className="config-row"><ConfigToggle label="MODE" options={['lockstep', 'realtime']} value={game.config.mode} onChange={(value) => resetRun(game.config.seed, { mode: value as RunMode })} /><ConfigToggle label="LANG" options={['ko', 'en']} value={game.config.locale} onChange={(value) => resetRun(game.config.seed, { locale: value as Locale })} /><ConfigToggle label="LAYOUT" options={['A', 'B']} value={layoutProfile} onChange={(value) => resetRun(game.config.seed, { layout: value as LayoutProfile })} /></div></Modal>;
}

function ResultDialog({ game, open, setOpen, resetRun }: { game: GameState; open: boolean; setOpen: (open: boolean) => void; resetRun: (seed?: number) => void }) {
  const report = createRunReport(game); const t = COPY[game.config.locale];
  return <Modal open={open} onClose={() => setOpen(false)} eyebrow={`${game.phase === 'won' ? 'MISSION COMPLETE' : 'MISSION TERMINATED'} · SEED ${game.config.seed}`} title={`${t.result}: ${report.score.total.toLocaleString()}`} description={game.phase === 'won' ? (game.config.locale === 'ko' ? '정거장을 안정화했습니다.' : 'Station stabilized.') : (game.config.locale === 'ko' ? '행동 로그에서 실패 원인을 확인하세요.' : 'Review the action log for the failure.')} footer={<><Button variant="outline" className="control-button" onClick={() => downloadReplay(game)}><Download />JSON</Button><Button variant="outline" className="control-button" onClick={() => resetRun(game.config.seed)}><RotateCcw />{game.config.locale === 'ko' ? '같은 시드' : 'Same seed'}</Button><Button className="start-button h-9 px-4" onClick={() => resetRun(game.config.seed + 1)}><Play />{game.config.locale === 'ko' ? '다음 시드' : 'Next seed'}</Button></>}><div className="report-summary"><ReportStat label="TICKS" value={String(report.tick)} /><ReportStat label="RESOLVED" value={`${game.stats.incidentsResolved}/${game.incidents.length}`} /><ReportStat label="INVALID" value={String(game.stats.invalidActions)} /><ReportStat label="SAFETY" value={String(report.score.safety)} /></div><div className="capability-list">{report.capabilities.map((item) => <div key={item.id}><span>{game.config.locale === 'ko' ? item.labelKo : item.labelEn}</span><div><i style={{ width: `${item.score}%` }} /></div><strong>{item.score}</strong></div>)}</div></Modal>;
}

function InfoDialogs({ game, helpOpen, setHelpOpen, historyOpen, setHistoryOpen, replayIndex }: { game: GameState; helpOpen: boolean; setHelpOpen: (open: boolean) => void; historyOpen: boolean; setHistoryOpen: (open: boolean) => void; replayIndex: ReturnType<typeof loadReplayIndex> }) {
  const t = COPY[game.config.locale];
  const helpLines = game.config.locale === 'ko' ? ['경보 카드를 눌러 사고와 대상 구역을 확인합니다.', '드론 탭에서 드론을 고르고 인접 구역을 한 칸씩 이동합니다.', '누출과 전기 아크는 전력을 먼저 끕니다.', '올바른 도구를 클릭하거나 사고 구역으로 드래그합니다.', '모든 사고 해결 후 꺼진 전력을 복구합니다.'] : ['Select an incident card and inspect its target room.', 'Choose a drone and move one adjacent room at a time.', 'Cut power before repairing a leak or electrical arc.', 'Click the correct tool or drag it onto the incident room.', 'Restore power after every incident is resolved.'];
  return <><Modal open={helpOpen} onClose={() => setHelpOpen(false)} title={t.help} description={game.config.locale === 'ko' ? '모든 핵심 조작은 화면에 보이는 요소만으로 완료할 수 있습니다.' : 'Every core task can be completed from visible screen information.'}><ol className="help-list">{helpLines.map((line, index) => <li key={line}><span>{String(index + 1).padStart(2, '0')}</span>{line}</li>)}</ol></Modal><Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title={t.history} description="LOCAL REPLAY INDEX · MAX 20"><div className="history-list">{replayIndex.length === 0 && <p>{game.config.locale === 'ko' ? '저장된 완료 기록이 없습니다.' : 'No completed runs saved.'}</p>}{replayIndex.map((item) => <div key={item.runId}><span className={item.success ? 'success' : 'failure'}>{item.success ? 'PASS' : 'FAIL'}</span><strong>SEED {item.seed}</strong><span>{item.score.toLocaleString()} PTS</span><time>{new Date(item.savedAt).toLocaleString()}</time></div>)}</div></Modal></>;
}

function Modal({ open, onClose, eyebrow, title, description, footer, children }: { open: boolean; onClose?: () => void; eyebrow?: string; title: string; description?: string; footer?: React.ReactNode; children: React.ReactNode }) {
  if (!open) return null;
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && onClose) onClose(); }}><section className="mission-dialog modal-card" role="dialog" aria-modal="true" aria-label={title}><header>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<div className="modal-title-row"><h2>{title}</h2>{onClose && <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">×</Button>}</div>{description && <p className="modal-description">{description}</p>}</header>{children}{footer && <footer className="modal-footer">{footer}</footer>}</section></div>;
}

function getDirective(game: GameState, droneId: DroneId, incidentId: string): string {
  const ko = game.config.locale === 'ko';
  if (game.phase === 'briefing') return ko ? '브리핑을 확인하고 평가를 시작하세요.' : 'Review the briefing and start.';
  if (game.phase === 'won') return ko ? '모든 구역 안정화 완료.' : 'All sectors stabilized.';
  if (game.phase === 'lost') return ko ? '평가가 종료되었습니다. 로그를 검토하세요.' : 'Run terminated. Review the log.';
  const incident = game.incidents.find((item) => item.id === incidentId && item.status === 'active') ?? game.incidents.find((item) => item.status === 'active');
  if (!incident) return ko ? '꺼진 구역의 전원을 모두 복구하세요.' : 'Restore power to every room.';
  const room = game.rooms.find((item) => item.id === incident.roomId);
  const definition = INCIDENT_DEFS[incident.kind];
  if (definition.requiresPowerOff && room?.powered) return ko ? `${incident.roomId} 전력을 먼저 차단하세요.` : `Cut power to ${incident.roomId} first.`;
  const drone = game.drones[droneId];
  const inRange = incident.kind === 'door' ? drone.roomId === incident.roomId || ROOM_CONNECTIONS[incident.roomId].includes(drone.roomId) : drone.roomId === incident.roomId;
  if (!inRange) return ko ? `${droneId}를 ${incident.roomId} 작업 범위로 이동하세요.` : `Move ${droneId} into range of ${incident.roomId}.`;
  return ko ? `${TOOL_DEFS[definition.tool].labelKo}으로 ${INCIDENT_LABELS[incident.kind].ko}을 해결하세요.` : `Use ${TOOL_DEFS[definition.tool].labelEn} on the ${INCIDENT_LABELS[incident.kind].en.toLowerCase()}.`;
}

function IncidentGlyph({ kind, x, y }: { kind: IncidentKind; x: number; y: number }) {
  const color = kind === 'leak' ? '#69d6eb' : kind === 'fire' ? '#f0ae57' : '#ff747b';
  return <g transform={`translate(${x} ${y})`}><circle r="16" fill="#09151b" stroke={color} strokeWidth="1.5" /><text textAnchor="middle" y="3.5" fill={color} fontSize="8" fontWeight="800">{INCIDENT_LABELS[kind].code}</text></g>;
}

function DroneGlyph({ id, x, y, selected }: { id: DroneId; x: number; y: number; selected: boolean }) {
  return <g transform={`translate(${x} ${y})`}><circle r={selected ? 15 : 12} className={selected ? 'drone-glyph selected' : 'drone-glyph'} /><path d="M-6-3h12v6H-6zM-3-7h6M-3 7h6" className="drone-line" /><text x="18" y="4" className="drone-label">{id.slice(0, 1)}</text></g>;
}

function PanelHeading({ icon, title, meta }: { icon: React.ReactNode; title: string; meta: string }) { return <div className="flex items-center justify-between border-b border-[#20333b] pb-2"><div className="flex items-center gap-2 text-sm font-semibold tracking-wide text-[#d8e9eb]">{icon}{title}</div><span className="text-[10px] font-bold tracking-[.14em] text-[#5e7b84]">{meta}</span></div>; }
function StatusCell({ label, value, tone }: { label: string; value: string; tone: string }) { return <div className="status-cell"><span>{label}</span><strong data-tone={tone}>{value}</strong></div>; }

function AlertCard({ locale, incident, selected, onClick }: { locale: Locale; incident: GameState['incidents'][number]; selected: boolean; onClick: () => void }) {
  const Icon = incident.kind === 'leak' ? Droplets : incident.kind === 'fire' ? Flame : incident.kind === 'arc' ? Zap : LockKeyhole;
  return <button onClick={onClick} aria-current={selected} className={`alert-card w-full text-left ${selected ? 'active' : ''} ${incident.status === 'resolved' ? 'resolved' : ''}`}><span className="alert-icon"><Icon size={18} /></span><span className="min-w-0"><span className="block text-[10px] font-bold tracking-[.13em] text-[#f08b72]">{incident.status === 'resolved' ? 'RESOLVED' : `S${incident.severity} · ${incident.roomId}`}</span><strong className="mt-1 block text-sm">{INCIDENT_LABELS[incident.kind][locale]}</strong><span className="mt-1 block text-xs leading-relaxed text-[#82979e]">{incident.id} · {incident.status === 'resolved' ? (locale === 'ko' ? '처리 완료' : 'Resolved') : `T+${incident.spawnedAt}`}</span></span></button>;
}

function ToolButton({ toolId, locale, count, disabled, onUse }: { toolId: ToolId; locale: Locale; count: number; disabled: boolean; onUse: () => void }) {
  const def = TOOL_DEFS[toolId]; const Icon = toolId === 'sealant' ? Wrench : toolId === 'foam' ? Flame : toolId === 'circuit' ? Zap : LockKeyhole;
  return <button draggable={!disabled && count > 0} onDragStart={(event) => { event.dataTransfer.setData('application/x-shift-tool', toolId); event.dataTransfer.effectAllowed = 'copy'; }} onClick={onUse} disabled={disabled || count <= 0} className="tool-button"><span><Icon size={17} /></span><strong>{def[locale === 'ko' ? 'labelKo' : 'labelEn']}</strong><small>{def.code} · {String(count).padStart(2, '0')}</small></button>;
}

function BriefItem({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) { return <div><span>{icon}</span><strong>{title}</strong><p>{detail}</p></div>; }
function ConfigToggle({ label, options, value, onChange }: { label: string; options: string[]; value: string; onChange: (value: string) => void }) { return <div><span>{label}</span><div>{options.map((option) => <button key={option} className={value === option ? 'active' : ''} onClick={() => onChange(option)}>{option.toUpperCase()}</button>)}</div></div>; }
function ReportStat({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }

import type {
  BranchId, Effect, Encounter, EvidenceCue, Item, NPC, Objective, Predicate, Quest, Recipe,
  Region, Rumor, Shop, Tide, TruthFact,
} from "./schema.ts";

export interface ScenarioOptions {
  lampBinder: "forest_resin" | "moon_dust";
  mineTide: Tide;
  wispWard: "signal_flare" | "herbal_tonic";
  prismCatalyst: "true_pearl" | "wisp_dust";
  branchBonus: BranchId;
}

export interface ContentCatalog {
  regions: Region[];
  npcs: NPC[];
  quests: Quest[];
  items: Item[];
  encounters: Encounter[];
  recipes: Recipe[];
  shops: Shop[];
  rumors: Rumor[];
  evidenceCues: EvidenceCue[];
  facts: TruthFact[];
}

const ev = (factId: string): string[] => ["cue_" + factId];
const done = (questId: string): Predicate => ({ kind: "questState", questId, state: "complete" });
const active = (questId: string): Predicate => ({ kind: "questState", questId, state: "active" });
const has = (itemId: string, count = 1): Predicate => ({ kind: "hasItem", itemId, count });
const flag = (key: string, value: string | number | boolean): Predicate => ({ kind: "worldFlag", flag: key, value });

export function createCatalog(options: ScenarioOptions): ContentCatalog {
  const regions: Region[] = [
    {
      id: "ashen_harbor", nameKo: "잿빛 항구", summaryKo: "기록관·시장·여관이 모인 조사 거점.",
      mapPosition: { x: 470, y: 280 }, landmarkNamesKo: ["항구 기록관", "소금바람 여관", "낡은 부두"], visualKey: "harbor",
      exits: [
        { id: "harbor_mosswood", to: "mosswood", direction: "north", conditions: [], evidenceCueIds: ev("route_harbor_mosswood") },
        { id: "harbor_flats", to: "tidal_flats", direction: "east", conditions: [done("main_01_atlas")], blockedKo: "뱃사공이 지도 없는 항해를 거부한다.", evidenceCueIds: ev("route_harbor_flats") },
        { id: "harbor_observatory", to: "observatory", direction: "west", conditions: [done("main_05_divided")], blockedKo: "승강기가 항구의 계약 승인을 요구한다.", evidenceCueIds: ev("route_harbor_observatory") },
      ],
    },
    {
      id: "mosswood", nameKo: "이끼숲", summaryKo: "수지와 약초, 밤의 월광나방이 사는 숲.",
      mapPosition: { x: 300, y: 105 }, landmarkNamesKo: ["수지 상처목", "푸른 약초밭", "달빛 공터"], visualKey: "forest",
      exits: [
        { id: "mosswood_harbor", to: "ashen_harbor", direction: "south", conditions: [], evidenceCueIds: ev("route_mosswood_harbor") },
        { id: "mosswood_marsh", to: "glass_marsh", direction: "west", conditions: [done("main_04_ledger")], blockedKo: "안개길의 좌표를 아직 모른다.", evidenceCueIds: ev("route_mosswood_marsh") },
      ],
    },
    {
      id: "tidal_flats", nameKo: "조수 갯벌", summaryKo: "조수에 따라 길과 생물이 달라지는 동쪽 해안.",
      mapPosition: { x: 690, y: 205 }, landmarkNamesKo: ["게 바위", "조개톱 여울", "광산 수문"], visualKey: "flats",
      exits: [
        { id: "flats_harbor", to: "ashen_harbor", direction: "west", conditions: [], evidenceCueIds: ev("route_flats_harbor") },
        { id: "flats_mine", to: "drowned_mine", direction: "south", conditions: [has("diving_lamp"), { kind: "tide", value: options.mineTide }, flag("sluice_open", true)], blockedKo: "어둠과 수압이 광산 입구를 막는다.", evidenceCueIds: ev("route_flats_mine") },
      ],
    },
    {
      id: "drowned_mine", nameKo: "침수 광산", summaryKo: "녹슨 파수기가 감독관 장부를 지키는 갱도.",
      mapPosition: { x: 660, y: 420 }, landmarkNamesKo: ["배수 제어실", "구리 적치장", "감독관 금고"], visualKey: "mine",
      exits: [
        { id: "mine_flats", to: "tidal_flats", direction: "north", conditions: [], evidenceCueIds: ev("route_mine_flats") },
        { id: "mine_marsh", to: "glass_marsh", direction: "west", conditions: [has("mine_ledger")], blockedKo: "안개문이 광산 장부의 인장을 요구한다.", evidenceCueIds: ev("route_mine_marsh") },
      ],
    },
    {
      id: "glass_marsh", nameKo: "유리습지", summaryKo: "빛을 머금는 갈대와 도깨비불의 안개 습지.",
      mapPosition: { x: 260, y: 420 }, landmarkNamesKo: ["유리갈대 군락", "도깨비불 둥지", "안개문"], visualKey: "marsh",
      exits: [
        { id: "marsh_mosswood", to: "mosswood", direction: "east", conditions: [], evidenceCueIds: ev("route_marsh_mosswood") },
        { id: "marsh_mine", to: "drowned_mine", direction: "east", conditions: [has("mine_ledger")], blockedKo: "안개가 인장 없는 여행자를 밀어낸다.", evidenceCueIds: ev("route_marsh_mine") },
        { id: "marsh_observatory", to: "observatory", direction: "north", conditions: [has("star_prism")], blockedKo: "별빛 굴절문에 맞는 프리즘이 없다.", evidenceCueIds: ev("route_marsh_observatory") },
      ],
    },
    {
      id: "observatory", nameKo: "폐별 관측소", summaryKo: "항구 봉화를 제어하는 마지막 목적지.",
      mapPosition: { x: 120, y: 205 }, landmarkNamesKo: ["별빛 굴절문", "봉화 노심", "기록자 회랑"], visualKey: "observatory",
      exits: [
        { id: "observatory_harbor", to: "ashen_harbor", direction: "east", conditions: [], evidenceCueIds: ev("route_observatory_harbor") },
        { id: "observatory_marsh", to: "glass_marsh", direction: "south", conditions: [], evidenceCueIds: ev("route_observatory_marsh") },
      ],
    },
  ];

  const npcs: NPC[] = [
    {
      id: "npc_mira", nameKo: "미라", titleKo: "항구 기록관", regionId: "ashen_harbor", roles: ["quest", "information"], visualKey: "archivist",
      dialogue: [
        { id: "mira_intro", ko: "직접 확인한 관계만 지도에 기록하세요. 준과 소리에게 동쪽과 북쪽 길을 물어보세요.", conditions: [], effects: [{ kind: "startQuest", questId: "main_01_atlas" }], evidenceCueIds: ev("quest_main_01_atlas") },
        { id: "mira_branch", ko: "수호대와 인양단 중 하나와만 계약할 수 있어요.", conditions: [active("main_05_divided")], effects: [], evidenceCueIds: ev("branch_exclusive") },
        { id: "mira_divided", ko: "장부를 확인했으니 항로의 원칙을 정할 때예요. 두 진영의 대표를 만나세요.", conditions: [done("main_04_ledger")], effects: [{ kind: "startQuest", questId: "main_05_divided" }], evidenceCueIds: ev("quest_main_05_divided") },
        { id: "mira_final", ko: "장부와 선택의 증표로 노심을 완성해 관측소를 밝히세요.", conditions: [done("main_05_divided")], effects: [{ kind: "startQuest", questId: "main_06_beacon" }], evidenceCueIds: ev("quest_main_06_beacon") },
      ],
    },
    {
      id: "npc_jun", nameKo: "준", titleKo: "뱃사공", regionId: "ashen_harbor", roles: ["quest", "information"], visualKey: "ferryman",
      dialogue: [
        { id: "jun_route", ko: "동쪽은 조수 갯벌이오. 광산은 빛과 맞는 조수가 모두 필요하지.", conditions: [], effects: [], evidenceCueIds: ev("route_harbor_flats") },
        { id: "jun_tide_rumor", ko: "옛 선원들은 광산이 언제나 썰물에 열린다고 믿었소. 이번 계측도 그런지는 확인해야 하오.", conditions: [], effects: [], evidenceCueIds: ev("rumor_rumor_mine_tide") },
        { id: "jun_rope", ko: "낡은 밧줄에 숲 수지를 먹이면 다시 쓸 수 있소.", conditions: [done("main_01_atlas")], effects: [{ kind: "startQuest", questId: "side_02_rope" }], evidenceCueIds: ev("quest_side_02_rope") },
      ],
    },
    {
      id: "npc_sena", nameKo: "세나", titleKo: "숲 약제사", regionId: "mosswood", roles: ["quest", "craft"], visualKey: "herbalist",
      dialogue: [
        { id: "sena_tonic", ko: "푸른소금풀과 달미역을 달이면 안개를 누르는 영약이 됩니다.", conditions: [], effects: [{ kind: "startQuest", questId: "side_01_tonic" }], evidenceCueIds: ev("recipe_recipe_herbal_tonic") },
        { id: "sena_lamp", ko: "이번 잠수등 접합재는 " + (options.lampBinder === "forest_resin" ? "숲 수지" : "월광 가루") + "예요. 닮은 재료는 물속에서 깨집니다.", conditions: [done("main_01_atlas")], effects: [{ kind: "startQuest", questId: "main_02_lamp" }], evidenceCueIds: ev("recipe_recipe_diving_lamp") },
      ],
    },
    {
      id: "npc_doyun", nameKo: "도윤", titleKo: "여관지기", regionId: "ashen_harbor", roles: ["inn", "information"], visualKey: "innkeeper",
      dialogue: [
        { id: "doyun_night", ko: "밤까지 쉽니다. 월광나방은 해가 진 뒤에만 내려앉아요.", conditions: [{ kind: "time", value: "day" }], effects: [{ kind: "setTime", value: "night" }], evidenceCueIds: ev("state_time") },
        { id: "doyun_day", ko: "아침까지 쉽니다. 낮에는 약초 잎맥이 잘 보입니다.", conditions: [{ kind: "time", value: "night" }], effects: [{ kind: "setTime", value: "day" }], evidenceCueIds: ev("state_time") },
      ],
    },
    {
      id: "npc_bora", nameKo: "보라", titleKo: "보급상", regionId: "ashen_harbor", roles: ["shop", "exchange", "quest"], visualKey: "merchant",
      dialogue: [
        { id: "bora_shop", ko: "구리와 밧줄은 동전으로, 조수 진주는 껍질 세 개로 바꿔요.", conditions: [], effects: [], evidenceCueIds: ev("offer_exchange_true_pearl") },
        { id: "bora_wisp_rumor", ko: "도깨비불은 여러 번 몰아붙이면 가루를 남긴다는 소문도 있어요.", conditions: [], effects: [], evidenceCueIds: ev("rumor_rumor_wisp_force") },
        { id: "bora_shell", ko: "갯게 껍질을 조사하면 진짜 진주와 가짜를 구분할 수 있겠죠.", conditions: [done("main_01_atlas")], effects: [{ kind: "startQuest", questId: "side_03_shell_trade" }], evidenceCueIds: ev("quest_side_03_shell_trade") },
      ],
    },
    {
      id: "npc_hael", nameKo: "하엘", titleKo: "항로 수호대장", regionId: "ashen_harbor", roles: ["quest", "shop"], visualKey: "warden",
      dialogue: [
        { id: "hael_choose", ko: "공공 항로를 원한다면 수호대와 계약하십시오. 인양단 계약은 닫힙니다.", conditions: [active("main_05_divided")], effects: [{ kind: "chooseBranch", value: "wardens" }, { kind: "setFlag", flag: "branch_resolved", value: true }, { kind: "giveItem", itemId: "wardens_seal" }], evidenceCueIds: ev("branch_wardens") },
      ],
    },
    {
      id: "npc_rato", nameKo: "라토", titleKo: "인양단 대표", regionId: "tidal_flats", roles: ["quest", "exchange"], visualKey: "salvager",
      dialogue: [
        { id: "rato_choose", ko: "발견자 우선권을 원하면 인양단과 계약해. 수호대 계약은 끝이야.", conditions: [active("main_05_divided")], effects: [{ kind: "chooseBranch", value: "salvagers" }, { kind: "setFlag", flag: "branch_resolved", value: true }, { kind: "giveItem", itemId: "salvagers_mark" }], evidenceCueIds: ev("branch_salvagers") },
        { id: "rato_rumor", ko: "붉은 갯게 배 속에는 별진주가 들었다고들 하지. 직접 본 적은 없지만.", conditions: [], effects: [], evidenceCueIds: ev("rumor_rumor_crab_pearl") },
      ],
    },
    {
      id: "npc_moha", nameKo: "모하", titleKo: "전직 광부", regionId: "drowned_mine", roles: ["quest", "information"], visualKey: "miner",
      dialogue: [
        { id: "moha_ledger", ko: "녹슨 파수기가 감독관 장부를 지킵니다.", conditions: [done("main_03_sluice")], effects: [{ kind: "startQuest", questId: "main_04_ledger" }], evidenceCueIds: ev("quest_main_04_ledger") },
        { id: "moha_badge", ko: "파수기의 광부 표식을 회수해 주시오.", conditions: [done("main_02_lamp")], effects: [{ kind: "startQuest", questId: "side_04_badge" }], evidenceCueIds: ev("quest_side_04_badge") },
      ],
    },
    {
      id: "npc_yeon", nameKo: "연", titleKo: "렌즈 기술자", regionId: "ashen_harbor", roles: ["quest", "craft"], visualKey: "lenswright",
      dialogue: [
        { id: "yeon_prism", ko: "별빛 프리즘 촉매는 " + (options.prismCatalyst === "true_pearl" ? "조수 진주" : "도깨비불 가루") + "입니다.", conditions: [done("main_04_ledger")], effects: [], evidenceCueIds: ev("recipe_recipe_star_prism") },
        { id: "yeon_core", ko: "프리즘과 구리, 두 계약 증표 중 하나를 노심으로 묶으세요.", conditions: [done("main_05_divided")], effects: [], evidenceCueIds: ev("recipe_recipe_beacon_core") },
      ],
    },
    {
      id: "npc_sori", nameKo: "소리", titleKo: "숲길 안내자", regionId: "mosswood", roles: ["quest", "information"], visualKey: "ranger",
      dialogue: [
        { id: "sori_route", ko: "북문은 이끼숲. 광산 장부가 있으면 서쪽 습지길도 보여요.", conditions: [], effects: [], evidenceCueIds: ev("route_mosswood_marsh") },
        { id: "sori_wisp", ko: "도깨비불은 " + (options.wispWard === "signal_flare" ? "신호 불꽃" : "약초 영약") + "을 지닌 사람에게만 가루를 남겨요.", conditions: [done("main_04_ledger")], effects: [{ kind: "startQuest", questId: "side_05_wisp" }], evidenceCueIds: ev("encounter_mire_wisp") },
      ],
    },
    {
      id: "npc_neri", nameKo: "네리", titleKo: "조수 연구자", regionId: "tidal_flats", roles: ["quest", "information"], visualKey: "tide_scholar",
      dialogue: [
        { id: "neri_low", ko: "수문 바퀴를 돌려 썰물로 바꿨습니다.", conditions: [{ kind: "tide", value: "high" }], effects: [{ kind: "setTide", value: "low" }], evidenceCueIds: ev("state_tide") },
        { id: "neri_high", ko: "수문 바퀴를 돌려 밀물로 바꿨습니다.", conditions: [{ kind: "tide", value: "low" }], effects: [{ kind: "setTide", value: "high" }], evidenceCueIds: ev("state_tide") },
        { id: "neri_sluice", ko: "이번 광산 수문은 " + (options.mineTide === "low" ? "썰물" : "밀물") + " 압력에서 열립니다.", conditions: [done("main_02_lamp")], effects: [{ kind: "startQuest", questId: "main_03_sluice" }], evidenceCueIds: ev("quest_main_03_sluice") },
        { id: "neri_tide_counter", ko: "오래된 썰물 통설보다 이번 계측침의 압력을 따라야 합니다.", conditions: [done("main_02_lamp")], effects: [], evidenceCueIds: ev("counter_rumor_mine_tide") },
        { id: "neri_open", ko: "계측침이 맞았습니다. 압력열쇠로 광산 수문을 엽니다.", conditions: [active("main_03_sluice"), { kind: "tide", value: options.mineTide }], effects: [{ kind: "setFlag", flag: "sluice_open", value: true }], evidenceCueIds: ev("state_sluice_open") },
        { id: "neri_repeat", ko: "붉은 갯게 표본은 계속 필요합니다.", conditions: [done("side_03_shell_trade")], effects: [{ kind: "startQuest", questId: "repeat_01_tide_sample" }], evidenceCueIds: ev("quest_repeat_01_tide_sample") },
      ],
    },
    {
      id: "npc_echo", nameKo: "에코", titleKo: "관측소 기록체", regionId: "observatory", roles: ["quest", "information"], visualKey: "automaton",
      dialogue: [
        { id: "echo_finish", ko: "봉화 노심을 설치하면 기록이 완성됩니다.", conditions: [active("main_06_beacon"), has("beacon_core")], effects: [{ kind: "takeItem", itemId: "beacon_core" }, { kind: "setFlag", flag: "beacon_lit", value: true }], evidenceCueIds: ev("state_beacon") },
        { id: "echo_counter", ko: "도깨비불은 공격 횟수가 아니라 소지한 보호 도구를 판별한다.", conditions: [], effects: [], evidenceCueIds: ev("counter_rumor_wisp_force") },
      ],
    },
  ];

  const quests: Quest[] = [
    {
      id: "main_01_atlas", titleKo: "빈 지도", summaryKo: "준과 소리에게 길을 묻고 첫 지역 관계를 확인한다.", category: "main",
      giverNpcId: "npc_mira", turnInNpcId: "npc_mira", prerequisites: [],
      objectives: [{ kind: "talk", npcId: "npc_jun" }, { kind: "talk", npcId: "npc_sori" }],
      rewards: [{ kind: "giveItem", itemId: "atlas_page" }, { kind: "unlockRegion", regionId: "mosswood" }, { kind: "unlockRegion", regionId: "tidal_flats" }],
      evidenceCueIds: ev("quest_main_01_atlas"),
    },
    {
      id: "main_02_lamp", titleKo: "물속의 빛", summaryKo: "시나리오에 맞는 접합재로 방수 잠수등을 제작한다.", category: "main",
      giverNpcId: "npc_sena", turnInNpcId: "npc_sena", prerequisites: [done("main_01_atlas")],
      objectives: [{ kind: "craft", recipeId: "recipe_diving_lamp" }, { kind: "collect", itemId: "diving_lamp", count: 1 }],
      rewards: [{ kind: "unlockRegion", regionId: "drowned_mine" }], evidenceCueIds: ev("quest_main_02_lamp"),
    },
    {
      id: "main_03_sluice", titleKo: "조수와 수문", summaryKo: "조수를 " + (options.mineTide === "low" ? "썰물" : "밀물") + "로 맞춰 광산 수문을 연다.", category: "main",
      giverNpcId: "npc_neri", turnInNpcId: "npc_neri", prerequisites: [done("main_02_lamp")],
      objectives: [{ kind: "setFlag", flag: "sluice_open", value: true }],
      rewards: [{ kind: "giveItem", itemId: "pressure_key" }], evidenceCueIds: ev("quest_main_03_sluice"),
    },
    {
      id: "main_04_ledger", titleKo: "물밑의 장부", summaryKo: "녹슨 파수기를 조사해 감독관 장부를 회수한다.", category: "main",
      giverNpcId: "npc_moha", turnInNpcId: "npc_mira", prerequisites: [done("main_03_sluice"), has("diving_lamp")],
      objectives: [{ kind: "encounter", encounterId: "rust_sentinel" }, { kind: "collect", itemId: "mine_ledger", count: 1 }],
      rewards: [{ kind: "unlockRegion", regionId: "glass_marsh" }], evidenceCueIds: ev("quest_main_04_ledger"),
    },
    {
      id: "main_05_divided", titleKo: "갈라진 항로", summaryKo: "두 진영의 주장을 듣고 한쪽과만 계약한다.", category: "main",
      giverNpcId: "npc_mira", turnInNpcId: "npc_mira", prerequisites: [done("main_04_ledger")],
      objectives: [{ kind: "setFlag", flag: "branch_resolved", value: true }],
      rewards: [{ kind: "unlockRegion", regionId: "observatory" }], branchGroup: "harbor_compact", evidenceCueIds: ev("quest_main_05_divided"),
    },
    {
      id: "main_06_beacon", titleKo: "별빛을 기록하다", summaryKo: "별빛 프리즘과 계약 증표로 봉화 노심을 완성해 점등한다.", category: "main",
      giverNpcId: "npc_mira", turnInNpcId: "npc_echo", prerequisites: [done("main_05_divided"), has("mine_ledger")],
      objectives: [{ kind: "craft", recipeId: "recipe_beacon_core" }, { kind: "visit", regionId: "observatory" }, { kind: "setFlag", flag: "beacon_lit", value: true }],
      rewards: [{ kind: "giveItem", itemId: "master_record" }, { kind: "setFlag", flag: "atlas_complete", value: true }], evidenceCueIds: ev("quest_main_06_beacon"),
    },
    {
      id: "side_01_tonic", titleKo: "안개를 누르는 향", summaryKo: "푸른소금풀과 달미역으로 약초 영약을 만든다.", category: "side",
      giverNpcId: "npc_sena", turnInNpcId: "npc_sena", prerequisites: [],
      objectives: [{ kind: "craft", recipeId: "recipe_herbal_tonic" }], rewards: [{ kind: "giveItem", itemId: "coin", count: 3 }], evidenceCueIds: ev("quest_side_01_tonic"),
    },
    {
      id: "side_02_rope", titleKo: "끊어진 항로", summaryKo: "낡은 밧줄을 숲 수지로 수리한다.", category: "side",
      giverNpcId: "npc_jun", turnInNpcId: "npc_jun", prerequisites: [done("main_01_atlas")],
      objectives: [{ kind: "craft", recipeId: "recipe_repaired_rope" }, { kind: "collect", itemId: "repaired_rope", count: 1 }],
      rewards: [{ kind: "giveItem", itemId: "survey_token" }], evidenceCueIds: ev("quest_side_02_rope"),
    },
    {
      id: "side_03_shell_trade", titleKo: "껍질의 값", summaryKo: "갯게 껍질 세 개를 모아 진주 교환 규칙을 확인한다.", category: "side",
      giverNpcId: "npc_bora", turnInNpcId: "npc_bora", prerequisites: [done("main_01_atlas")],
      objectives: [{ kind: "collect", itemId: "tide_shell", count: 3 }], rewards: [{ kind: "giveItem", itemId: "coin", count: 2 }], evidenceCueIds: ev("quest_side_03_shell_trade"),
    },
    {
      id: "side_04_badge", titleKo: "광부의 마지막 표식", summaryKo: "녹슨 파수기에게서 광부 표식을 회수한다.", category: "side",
      giverNpcId: "npc_moha", turnInNpcId: "npc_moha", prerequisites: [done("main_02_lamp")],
      objectives: [{ kind: "collect", itemId: "miner_badge", count: 1 }], rewards: [{ kind: "giveItem", itemId: "copper_scrap", count: 2 }], evidenceCueIds: ev("quest_side_04_badge"),
    },
    {
      id: "side_05_wisp", titleKo: "유리습지 표본", summaryKo: "보호 도구의 조건을 알아내 도깨비불 가루와 유리갈대를 조사한다.", category: "side",
      giverNpcId: "npc_sori", turnInNpcId: "npc_sori", prerequisites: [done("main_04_ledger")],
      objectives: [{ kind: "encounter", encounterId: "mire_wisp" }, { kind: "collect", itemId: "glass_reed", count: 2 }],
      rewards: [{ kind: "giveItem", itemId: "lens_blank" }], evidenceCueIds: ev("quest_side_05_wisp"),
    },
    {
      id: "hidden_01_false_pearl", titleKo: "별진주의 반례", summaryKo: "갯게의 유사 진주와 교환소의 진짜 진주를 비교한다.", category: "hidden",
      giverNpcId: "npc_rato", turnInNpcId: "npc_bora", prerequisites: [{ kind: "rumorHeard", rumorId: "rumor_crab_pearl" }],
      objectives: [{ kind: "collect", itemId: "false_pearl", count: 1 }, { kind: "collect", itemId: "true_pearl", count: 1 }],
      rewards: [{ kind: "giveItem", itemId: "survey_token" }, { kind: "setFlag", flag: "rumor_crab_refuted", value: true }], evidenceCueIds: ev("quest_hidden_01_false_pearl"),
    },
    {
      id: "hidden_02_moon_moth", titleKo: "달빛 아래의 날개", summaryKo: "밤의 이끼숲에서만 나타나는 월광나방을 기록한다.", category: "hidden",
      giverNpcId: "npc_doyun", turnInNpcId: "npc_sena", prerequisites: [{ kind: "time", value: "night" }],
      objectives: [{ kind: "encounter", encounterId: "moon_moth" }, { kind: "collect", itemId: "moon_dust", count: 1 }],
      rewards: [{ kind: "giveItem", itemId: "coin", count: 4 }], evidenceCueIds: ev("quest_hidden_02_moon_moth"),
    },
    {
      id: "repeat_01_tide_sample", titleKo: "오늘의 조수 표본", summaryKo: "순환하는 갯벌 표본을 다시 수집한다.", category: "repeatable",
      giverNpcId: "npc_neri", turnInNpcId: "npc_neri", prerequisites: [done("side_03_shell_trade")],
      objectives: [{ kind: "collect", itemId: "crab_claw", count: 2 }], rewards: [{ kind: "takeItem", itemId: "crab_claw", count: 2 }, { kind: "giveItem", itemId: "coin", count: 2 }],
      repeatable: true, evidenceCueIds: ev("quest_repeat_01_tide_sample"),
    },
  ];

  const encounters: Encounter[] = [
    { id: "salt_herb_patch", kind: "gather", nameKo: "푸른소금풀 군락", descriptionKo: "낮에 잎맥이 밝아지는 약초밭.", regionId: "mosswood", spawnConditions: [{ kind: "time", value: "day" }], drops: [{ itemId: "salt_herb", count: 2, conditions: [], evidenceCueIds: ev("encounter_salt_herb_patch") }], respawns: true, evidenceCueIds: ev("encounter_salt_herb_patch"), visualKey: "herb_patch" },
    { id: "resin_tree", kind: "gather", nameKo: "수지 상처목", descriptionKo: "금빛 수지가 맺힌 오래된 나무.", regionId: "mosswood", spawnConditions: [], drops: [{ itemId: "forest_resin", count: 1, conditions: [], evidenceCueIds: ev("encounter_resin_tree") }], respawns: true, evidenceCueIds: ev("encounter_resin_tree"), visualKey: "resin_tree" },
    { id: "tidal_crab", kind: "monster", nameKo: "붉은 갯게", descriptionKo: "밀물에 나타나 껍질과 흐린 유사 진주를 남긴다.", regionId: "tidal_flats", spawnConditions: [{ kind: "tide", value: "high" }], drops: [{ itemId: "tide_shell", count: 1, conditions: [], evidenceCueIds: ev("encounter_tidal_crab") }, { itemId: "crab_claw", count: 1, conditions: [], evidenceCueIds: ev("encounter_tidal_crab") }, { itemId: "false_pearl", count: 1, conditions: [], evidenceCueIds: ev("counter_rumor_crab_pearl") }], respawns: true, evidenceCueIds: ev("encounter_tidal_crab"), visualKey: "red_crab" },
    { id: "moon_moth", kind: "monster", nameKo: "월광나방", descriptionKo: "밤의 달빛 공터에서만 내려앉는 비공격성 생물.", regionId: "mosswood", spawnConditions: [{ kind: "time", value: "night" }], drops: [{ itemId: "moon_dust", count: 1, conditions: [], evidenceCueIds: ev("encounter_moon_moth") }], respawns: true, evidenceCueIds: ev("encounter_moon_moth"), visualKey: "moon_moth" },
    { id: "mire_wisp", kind: "monster", nameKo: "안개 도깨비불", descriptionKo: "특정 보호 도구를 소지해야 잔여물을 남긴다.", regionId: "glass_marsh", spawnConditions: [has(options.wispWard)], requiredItemId: options.wispWard, drops: [{ itemId: "wisp_dust", count: 1, conditions: [has(options.wispWard)], evidenceCueIds: ev("encounter_mire_wisp") }], respawns: true, evidenceCueIds: [...ev("encounter_mire_wisp"), ...ev("scenario_wisp_ward")], visualKey: "mire_wisp" },
    { id: "rust_sentinel", kind: "monster", nameKo: "녹슨 파수기", descriptionKo: "감독관 금고와 광산 기록을 지키는 자동인형.", regionId: "drowned_mine", spawnConditions: [flag("sluice_open", true)], requiredItemId: "diving_lamp", drops: [{ itemId: "mine_ledger", count: 1, conditions: [], evidenceCueIds: ev("encounter_rust_sentinel") }, { itemId: "miner_badge", count: 1, conditions: [], evidenceCueIds: ev("encounter_rust_sentinel") }, { itemId: "copper_scrap", count: 2, conditions: [], evidenceCueIds: ev("encounter_rust_sentinel") }], respawns: false, evidenceCueIds: ev("encounter_rust_sentinel"), visualKey: "rust_sentinel" },
    { id: "glass_reed_bed", kind: "gather", nameKo: "유리갈대 군락", descriptionKo: "썰물 때 뿌리가 드러나는 빛 굴절 갈대.", regionId: "glass_marsh", spawnConditions: [{ kind: "tide", value: "low" }], drops: [{ itemId: "glass_reed", count: 2, conditions: [], evidenceCueIds: ev("encounter_glass_reed_bed") }], respawns: true, evidenceCueIds: ev("encounter_glass_reed_bed"), visualKey: "glass_reeds" },
  ];

  const recipes: Recipe[] = [
    { id: "recipe_diving_lamp", nameKo: "방수 잠수등", stationNpcId: "npc_sena", inputs: [{ alternatives: [{ itemId: "copper_scrap", count: 1 }] }, { alternatives: [{ itemId: options.lampBinder, count: 1 }] }], outputs: [{ itemId: "diving_lamp", count: 1 }], conditions: [done("main_01_atlas")], evidenceCueIds: [...ev("recipe_recipe_diving_lamp"), ...ev("scenario_lamp_binder")] },
    { id: "recipe_repaired_rope", nameKo: "수지 먹인 밧줄", stationNpcId: "npc_sena", inputs: [{ alternatives: [{ itemId: "old_rope", count: 1 }] }, { alternatives: [{ itemId: "forest_resin", count: 1 }] }], outputs: [{ itemId: "repaired_rope", count: 1 }], conditions: [], evidenceCueIds: ev("recipe_recipe_repaired_rope") },
    { id: "recipe_herbal_tonic", nameKo: "약초 영약", stationNpcId: "npc_sena", inputs: [{ alternatives: [{ itemId: "salt_herb", count: 1 }] }, { alternatives: [{ itemId: "moon_kelp", count: 1 }] }], outputs: [{ itemId: "herbal_tonic", count: 1 }], conditions: [], evidenceCueIds: ev("recipe_recipe_herbal_tonic") },
    { id: "recipe_signal_flare", nameKo: "신호 불꽃", stationNpcId: "npc_yeon", inputs: [{ alternatives: [{ itemId: "cave_lichen", count: 1 }] }, { alternatives: [{ itemId: "forest_resin", count: 1 }] }], outputs: [{ itemId: "signal_flare", count: 1 }], conditions: [done("main_02_lamp")], evidenceCueIds: ev("recipe_recipe_signal_flare") },
    { id: "recipe_lens_blank", nameKo: "렌즈 원판", stationNpcId: "npc_yeon", inputs: [{ alternatives: [{ itemId: "glass_reed", count: 2 }] }, { alternatives: [{ itemId: "copper_scrap", count: 1 }] }], outputs: [{ itemId: "lens_blank", count: 1 }], conditions: [done("main_04_ledger")], evidenceCueIds: ev("recipe_recipe_lens_blank") },
    { id: "recipe_star_prism", nameKo: "별빛 프리즘", stationNpcId: "npc_yeon", inputs: [{ alternatives: [{ itemId: "lens_blank", count: 1 }] }, { alternatives: [{ itemId: options.prismCatalyst, count: 1 }] }], outputs: [{ itemId: "star_prism", count: 1 }], conditions: [done("main_04_ledger")], evidenceCueIds: [...ev("recipe_recipe_star_prism"), ...ev("scenario_prism_catalyst")] },
    { id: "recipe_beacon_core", nameKo: "봉화 노심", stationNpcId: "npc_yeon", inputs: [{ alternatives: [{ itemId: "star_prism", count: 1 }] }, { alternatives: [{ itemId: "copper_scrap", count: 1 }] }, { alternatives: [{ itemId: "wardens_seal", count: 1 }, { itemId: "salvagers_mark", count: 1 }] }], outputs: [{ itemId: "beacon_core", count: 1 }], conditions: [done("main_05_divided")], evidenceCueIds: ev("recipe_recipe_beacon_core") },
  ];

  const shops: Shop[] = [
    {
      id: "shop_bora_supply", nameKo: "보라의 보급품", npcId: "npc_bora",
      offers: [
        { id: "buy_copper", kind: "buy", costs: [{ itemId: "coin", count: 2 }], rewards: [{ itemId: "copper_scrap", count: 1 }], conditions: [], evidenceCueIds: ev("offer_buy_copper") },
        { id: "buy_rope", kind: "buy", costs: [{ itemId: "coin", count: 1 }], rewards: [{ itemId: "old_rope", count: 1 }], conditions: [], evidenceCueIds: ev("offer_buy_rope") },
        { id: "buy_kelp", kind: "buy", costs: [{ itemId: "coin", count: 1 }], rewards: [{ itemId: "moon_kelp", count: 1 }], conditions: [], evidenceCueIds: ev("offer_buy_kelp") },
        { id: "buy_lichen", kind: "buy", costs: [{ itemId: "coin", count: 1 }], rewards: [{ itemId: "cave_lichen", count: 1 }], conditions: [done("main_02_lamp")], evidenceCueIds: ev("offer_buy_lichen") },
      ],
    },
    {
      id: "exchange_shell_counter", nameKo: "조개톱 교환대", npcId: "npc_bora",
      offers: [
        { id: "exchange_true_pearl", kind: "exchange", costs: [{ itemId: "tide_shell", count: 3 }], rewards: [{ itemId: "true_pearl", count: 1 }], conditions: [], evidenceCueIds: ev("offer_exchange_true_pearl") },
        { id: "exchange_claw_coin", kind: "exchange", costs: [{ itemId: "crab_claw", count: 2 }], rewards: [{ itemId: "coin", count: 1 }], conditions: [], evidenceCueIds: ev("offer_exchange_claw_coin") },
      ],
    },
    {
      id: "shop_branch_cache", nameKo: "항로 계약 보급함", npcId: "npc_hael",
      offers: [
        { id: "warden_cache", kind: "exchange", costs: [{ itemId: "survey_token", count: 1 }], rewards: [{ itemId: options.branchBonus === "wardens" ? "forest_resin" : "copper_scrap", count: 2 }], conditions: [{ kind: "branch", value: "wardens" }], evidenceCueIds: ev("offer_warden_cache") },
        { id: "salvager_cache", kind: "exchange", costs: [{ itemId: "survey_token", count: 1 }], rewards: [{ itemId: options.branchBonus === "salvagers" ? "forest_resin" : "copper_scrap", count: 2 }], conditions: [{ kind: "branch", value: "salvagers" }], evidenceCueIds: ev("offer_salvager_cache") },
      ],
    },
  ];

  const rumors: Rumor[] = [
    {
      id: "rumor_crab_pearl", speakerNpcId: "npc_rato", claimKo: "붉은 갯게는 별빛 프리즘에 쓸 진주를 떨어뜨린다.", truth: "false",
      correctionKo: "갯게의 흐린 알은 유사 진주다. 진짜 조수 진주는 껍질 세 개를 교환해 얻는다.",
      evidenceCueIds: ["cue_rumor_rumor_crab_pearl", "cue_counter_rumor_crab_pearl"],
    },
    {
      id: "rumor_wisp_force", speakerNpcId: "npc_bora", claimKo: "도깨비불은 여러 번 공격하면 반드시 가루를 남긴다.", truth: "false",
      correctionKo: "공격 횟수가 아니라 " + (options.wispWard === "signal_flare" ? "신호 불꽃" : "약초 영약") + " 소지가 필요하다.",
      evidenceCueIds: ["cue_rumor_rumor_wisp_force", "cue_counter_rumor_wisp_force"],
    },
    {
      id: "rumor_mine_tide", speakerNpcId: "npc_jun", claimKo: "광산은 언제나 썰물에 들어갈 수 있다.", truth: options.mineTide === "low" ? "partial" : "false",
      correctionKo: "이번 항로의 압력은 " + (options.mineTide === "low" ? "썰물" : "밀물") + "에 맞는다. 네리의 계측이 기준이다.",
      evidenceCueIds: ["cue_rumor_rumor_mine_tide", "cue_counter_rumor_mine_tide"],
    },
  ];

  const items = createItems(options);
  const { facts, evidenceCues } = buildEvidence({ regions, npcs, quests, items, encounters, recipes, shops, rumors }, options);
  return { regions, npcs, quests, items, encounters, recipes, shops, rumors, facts, evidenceCues };
}

function createItems(options: ScenarioOptions): Item[] {
  const source = (kind: Item["sources"][number]["kind"], sourceId: string, factId: string): Item["sources"] =>
    [{ kind, sourceId, conditions: [], evidenceCueIds: ev(factId) }];
  const make = (
    id: string, nameKo: string, descriptionKo: string, category: Item["category"],
    sources: Item["sources"], useKo: string[],
  ): Item => ({ id, nameKo, descriptionKo, category, sources, useKo, visualKey: id });

  return [
    make("coin", "항구 동전", "상점에서 통용되는 황동 동전.", "currency", source("quest", "side_01_tonic", "item_coin_source"), ["보급품 구매"]),
    make("atlas_page", "빈 지도책", "확인한 관계만 기록되는 조사 지도책.", "quest", source("quest", "main_01_atlas", "item_atlas_page_source"), ["지역·규칙 기록"]),
    make("salt_herb", "푸른소금풀", "낮에 잎맥이 밝아지는 약초.", "resource", source("gather", "salt_herb_patch", "item_salt_herb_source"), ["약초 영약"]),
    make("forest_resin", "숲 수지", "밧줄과 장치의 틈을 막는 수지.", "resource", source("gather", "resin_tree", "item_forest_resin_source"), ["밧줄 수리", "잠수등 또는 불꽃"]),
    make("copper_scrap", "구리 부품", "여러 장치의 골격이 되는 부품.", "resource", source("shop", "shop_bora_supply", "item_copper_scrap_source"), ["잠수등·렌즈·노심"]),
    make("tide_shell", "조수 껍질", "붉은 갯게의 파동 무늬 껍질.", "drop", source("encounter", "tidal_crab", "item_tide_shell_source"), ["조수 진주 교환"]),
    make("moon_kelp", "달미역", "은빛을 띠는 마른 해초.", "resource", source("shop", "shop_bora_supply", "item_moon_kelp_source"), ["약초 영약"]),
    make("glass_reed", "유리갈대", "빛을 굴절시키는 투명 줄기.", "resource", source("gather", "glass_reed_bed", "item_glass_reed_source"), ["렌즈 원판"]),
    make("cave_lichen", "동굴이끼", "불꽃을 오래 붙드는 마른 이끼.", "resource", source("shop", "shop_bora_supply", "item_cave_lichen_source"), ["신호 불꽃"]),
    make("moon_dust", "월광 가루", "월광나방이 남긴 은빛 가루.", "drop", source("encounter", "moon_moth", "item_moon_dust_source"), ["일부 시나리오의 잠수등"]),
    make("wisp_dust", "도깨비불 가루", "보호 도구에 반응해 남은 가루.", "drop", source("encounter", "mire_wisp", "item_wisp_dust_source"), ["일부 시나리오의 프리즘"]),
    make("crab_claw", "붉은 집게", "조수 표본용 갯게 집게.", "drop", source("encounter", "tidal_crab", "item_crab_claw_source"), ["반복 의뢰", "동전 교환"]),
    make("miner_badge", "광부 표식", "침수 광산 노동자의 인식표.", "drop", source("encounter", "rust_sentinel", "item_miner_badge_source"), ["광부 의뢰"]),
    make("old_rope", "낡은 밧줄", "그대로는 항해에 쓸 수 없다.", "resource", source("shop", "shop_bora_supply", "item_old_rope_source"), ["수지 먹인 밧줄"]),
    make("diving_lamp", "방수 잠수등", (options.lampBinder === "forest_resin" ? "숲 수지" : "월광 가루") + "로 접합한 광산 등불.", "tool", source("craft", "recipe_diving_lamp", "item_diving_lamp_source"), ["침수 광산 진입"]),
    make("repaired_rope", "수지 먹인 밧줄", "물에 강하게 수리한 밧줄.", "crafted", source("craft", "recipe_repaired_rope", "item_repaired_rope_source"), ["뱃사공 의뢰"]),
    make("pressure_key", "수문 압력열쇠", "조수 압력에 맞춘 제어 열쇠.", "tool", source("quest", "main_03_sluice", "item_pressure_key_source"), ["광산 수문"]),
    make("mine_ledger", "감독관 장부", "안개길 좌표와 봉화 배선 기록.", "quest", source("encounter", "rust_sentinel", "item_mine_ledger_source"), ["습지 해금", "봉화 복구"]),
    make("lens_blank", "렌즈 원판", "프리즘 가공 전의 원판.", "crafted", source("craft", "recipe_lens_blank", "item_lens_blank_source"), ["별빛 프리즘"]),
    make("wardens_seal", "수호대 인장", "공공 항로 계약 증표.", "token", source("quest", "main_05_divided", "item_wardens_seal_source"), ["봉화 노심"]),
    make("salvagers_mark", "인양단 표식", "발견자 우선 계약 증표.", "token", source("quest", "main_05_divided", "item_salvagers_mark_source"), ["봉화 노심"]),
    make("star_prism", "별빛 프리즘", "별빛을 노심으로 모으는 결정.", "crafted", source("craft", "recipe_star_prism", "item_star_prism_source"), ["관측소 문", "봉화 노심"]),
    make("beacon_core", "봉화 노심", "프리즘과 계약 증표의 복구 부품.", "crafted", source("craft", "recipe_beacon_core", "item_beacon_core_source"), ["관측소 점등"]),
    make("false_pearl", "흐린 유사 진주", "프리즘에 쓸 수 없는 갯게 알.", "decoy", source("encounter", "tidal_crab", "item_false_pearl_source"), ["소문 반례"]),
    make("true_pearl", "조수 진주", "선명한 파동 무늬의 촉매.", "resource", source("exchange", "exchange_shell_counter", "item_true_pearl_source"), ["일부 시나리오의 프리즘"]),
    make("herbal_tonic", "약초 영약", "습지 안개를 누르는 영약.", "crafted", source("craft", "recipe_herbal_tonic", "item_herbal_tonic_source"), ["일부 시나리오의 도깨비불 보호"]),
    make("signal_flare", "신호 불꽃", "안개에서도 꺼지지 않는 불꽃.", "crafted", source("craft", "recipe_signal_flare", "item_signal_flare_source"), ["일부 시나리오의 도깨비불 보호"]),
    make("survey_token", "조사 증표", "반례와 표본을 기록한 보상.", "token", source("quest", "side_02_rope", "item_survey_token_source"), ["계약 보급함"]),
    make("master_record", "완성된 항로 기록", "관계와 예외가 검증된 최종 기록.", "quest", source("quest", "main_06_beacon", "item_master_record_source"), ["최종 완료 증명"]),
  ];
}

interface EvidenceInput {
  regions: Region[];
  npcs: NPC[];
  quests: Quest[];
  items: Item[];
  encounters: Encounter[];
  recipes: Recipe[];
  shops: Shop[];
  rumors: Rumor[];
}

function buildEvidence(input: EvidenceInput, options: ScenarioOptions): { facts: TruthFact[]; evidenceCues: EvidenceCue[] } {
  const facts: TruthFact[] = [];
  const evidenceCues: EvidenceCue[] = [];
  const names = new Map<string, string>([
    ...input.regions.map((entry) => [entry.id, entry.nameKo] as const),
    ...input.npcs.map((entry) => [entry.id, entry.nameKo] as const),
    ...input.quests.map((entry) => [entry.id, entry.titleKo] as const),
    ...input.items.map((entry) => [entry.id, entry.nameKo] as const),
    ...input.encounters.map((entry) => [entry.id, entry.nameKo] as const),
    ...input.recipes.map((entry) => [entry.id, entry.nameKo] as const),
    ...input.shops.map((entry) => [entry.id, entry.nameKo] as const),
    ["wardens", "수호대"], ["salvagers", "인양단"],
    ["sluice_open", "광산 수문 열림"], ["beacon_lit", "봉화 점등"],
    ["branch_resolved", "항로 계약 확정"], ["atlas_complete", "항로 기록 완성"],
  ]);
  const named = (id: string): string => names.get(id) ?? id;
  const sourceKindKo: Record<string, string> = { gather: "채집", encounter: "조우", quest: "퀘스트", shop: "상점", exchange: "교환", craft: "제작" };
  const predicateKo = (predicate: Predicate): string => {
    if (predicate.kind === "hasItem") return named(predicate.itemId) + " " + (predicate.count ?? 1) + "개 보유";
    if (predicate.kind === "questState") return "「" + named(predicate.questId) + "」 " + (predicate.state === "complete" ? "완료" : predicate.state === "active" ? "진행 중" : "수락 가능");
    if (predicate.kind === "worldFlag") return named(predicate.flag) + "=" + String(predicate.value);
    if (predicate.kind === "time") return predicate.value === "day" ? "낮" : "밤";
    if (predicate.kind === "tide") return predicate.value === "low" ? "썰물" : "밀물";
    if (predicate.kind === "branch") return named(predicate.value) + " 계약";
    return "소문 확인: " + named(predicate.rumorId);
  };
  const conditionsKo = (conditions: Predicate[]): string => conditions.length > 0 ? conditions.map(predicateKo).join(" + ") : "없음";
  const objectiveKo = (objective: Objective): string => {
    if (objective.kind === "talk") return named(objective.npcId) + "와 대화 " + (objective.count ?? 1) + "회";
    if (objective.kind === "collect") return named(objective.itemId) + " " + objective.count + "개 수집";
    if (objective.kind === "craft") return named(objective.recipeId) + " 제작 " + (objective.count ?? 1) + "회";
    if (objective.kind === "encounter") return named(objective.encounterId) + " 조우 " + (objective.count ?? 1) + "회";
    if (objective.kind === "visit") return named(objective.regionId) + " 방문";
    if (objective.kind === "setFlag") return named(objective.flag) + "=" + String(objective.value);
    return named(objective.branch) + " 계약 선택";
  };
  const effectKo = (effect: Effect): string => {
    if (effect.kind === "giveItem") return named(effect.itemId) + " " + (effect.count ?? 1) + "개 획득";
    if (effect.kind === "takeItem") return named(effect.itemId) + " " + (effect.count ?? 1) + "개 소모";
    if (effect.kind === "startQuest") return "「" + named(effect.questId) + "」 시작";
    if (effect.kind === "completeQuest") return "「" + named(effect.questId) + "」 완료";
    if (effect.kind === "setFlag") return named(effect.flag) + "=" + String(effect.value);
    if (effect.kind === "setTime") return (effect.value === "day" ? "낮" : "밤") + "으로 변경";
    if (effect.kind === "setTide") return (effect.value === "low" ? "썰물" : "밀물") + "로 변경";
    if (effect.kind === "chooseBranch") return named(effect.value) + " 계약 선택";
    if (effect.kind === "unlockRegion") return named(effect.regionId) + " 해금";
    return named(effect.faction) + " 평판 " + effect.amount;
  };
  const add = (
    id: string,
    subject: string,
    predicate: string,
    object: TruthFact["object"],
    importance: TruthFact["importance"],
    ko: string,
    sourceId = subject,
    kind: EvidenceCue["kind"] = "system",
  ): void => {
    const cueId = "cue_" + id;
    facts.push({ id, subject, predicate, object, importance, evidenceCueIds: [cueId] });
    evidenceCues.push({ id: cueId, kind, ko, sourceId, factIds: [id] });
  };

  for (const region of input.regions) {
    for (const exit of region.exits) {
      const target = input.regions.find((candidate) => candidate.id === exit.to);
      add(
        "route_" + exit.id,
        region.id,
        "connectsToWithConditions",
        [exit.to, JSON.stringify(exit.conditions)],
        exit.conditions.length > 0 ? "core" : "supporting",
        region.nameKo + "의 " + exit.direction + " 표지: " + (target?.nameKo ?? exit.to) + " — 통과 조건: " + conditionsKo(exit.conditions) + ".",
        region.id,
        "visual",
      );
    }
  }

  for (const quest of input.quests) {
    add(
      "quest_" + quest.id,
      quest.id,
      "procedure",
      [JSON.stringify(quest.prerequisites), JSON.stringify(quest.objectives), JSON.stringify(quest.rewards)],
      quest.category === "main" ? "core" : quest.category === "hidden" ? "exception" : "supporting",
      "의뢰 기록 「" + quest.titleKo + "」: " + quest.summaryKo + " 선행: " + conditionsKo(quest.prerequisites) + ". 목표: " + quest.objectives.map(objectiveKo).join(", ") + ". 보상: " + quest.rewards.map(effectKo).join(", ") + ".",
      quest.giverNpcId,
      "dialogue",
    );
  }

  for (const item of input.items) {
    add(
      "item_" + item.id + "_source",
      item.id,
      "hasSource",
      item.sources.map((source) => source.kind + ":" + source.sourceId),
      item.category === "quest" || item.category === "decoy" ? "core" : "supporting",
      "획득 기록 — " + item.nameKo + ": " + item.descriptionKo + " 획득처: " + item.sources.map((source) => named(source.sourceId) + "(" + (sourceKindKo[source.kind] ?? source.kind) + ", 조건 " + conditionsKo(source.conditions) + ")").join(", ") + ".",
      item.sources[0]?.sourceId ?? item.id,
      "result",
    );
  }

  for (const encounter of input.encounters) {
    const drops = encounter.drops.map((drop) => (names.get(drop.itemId) ?? drop.itemId) + "×" + drop.count).join(", ");
    add(
      "encounter_" + encounter.id,
      encounter.id,
      "spawnAndDrops",
      [JSON.stringify(encounter.spawnConditions), ...encounter.drops.map((drop) => drop.itemId)],
      encounter.id === "rust_sentinel" || encounter.id === "mire_wisp" ? "core" : "supporting",
      encounter.nameKo + ": " + encounter.descriptionKo + " 출현 조건: " + conditionsKo(encounter.spawnConditions) + (encounter.requiredItemId ? ", 필요 도구: " + named(encounter.requiredItemId) : "") + ". 관찰 결과 " + drops + " 획득. 반복 가능: " + (encounter.respawns ? "예" : "아니오") + ".",
      encounter.id,
      encounter.kind === "gather" ? "visual" : "result",
    );
  }

  for (const recipe of input.recipes) {
    const ingredientKo = recipe.inputs.map((group) =>
      group.alternatives.map((option) => (names.get(option.itemId) ?? option.itemId) + "×" + option.count).join(" 또는 "),
    ).join(" + ");
    const outputKo = recipe.outputs.map((output) => (names.get(output.itemId) ?? output.itemId) + "×" + output.count).join(", ");
    add(
      "recipe_" + recipe.id,
      recipe.id,
      "transforms",
      [
        ...recipe.inputs.map((group) => group.alternatives.map((option) => option.itemId + "x" + option.count).join("|")),
        "=>" + recipe.outputs.map((output) => output.itemId + "x" + output.count).join(","),
      ],
      ["recipe_diving_lamp", "recipe_star_prism", "recipe_beacon_core"].includes(recipe.id) ? "core" : "supporting",
      "제작 도식 「" + recipe.nameKo + "」: " + ingredientKo + " → " + outputKo + ". 조건: " + conditionsKo(recipe.conditions) + ".",
      recipe.stationNpcId,
      "visual",
    );
  }

  for (const shop of input.shops) {
    for (const offer of shop.offers) {
      const costs = offer.costs.map((cost) => (names.get(cost.itemId) ?? cost.itemId) + "×" + cost.count).join(", ");
      const rewards = offer.rewards.map((reward) => (names.get(reward.itemId) ?? reward.itemId) + "×" + reward.count).join(", ");
      add(
        "offer_" + offer.id,
        shop.id,
        offer.kind,
        [JSON.stringify(offer.costs), JSON.stringify(offer.rewards), JSON.stringify(offer.conditions)],
        offer.id === "exchange_true_pearl" ? "core" : "supporting",
        shop.nameKo + " 가격표: " + costs + " → " + rewards + ". 조건: " + conditionsKo(offer.conditions) + ".",
        shop.npcId,
        "visual",
      );
    }
  }

  add("state_time", "npc_doyun", "toggles", ["day", "night"], "core", "여관 시계가 휴식할 때마다 낮과 밤을 오간다.", "npc_doyun", "visual");
  add("state_tide", "npc_neri", "toggles", ["low", "high"], "core", "수문 바퀴를 돌리자 조수 계측침이 반대 눈금으로 움직인다.", "npc_neri", "visual");
  add("state_sluice_open", "npc_neri", "setsFlag", "sluice_open", "core", "정답 조수에서 압력열쇠가 맞물리며 광산 수문이 열린다.", "npc_neri", "result");
  add("state_beacon", "beacon_core", "setsFlag", "beacon_lit", "core", "노심을 설치하자 관측소에 별빛이 흐른다.", "npc_echo", "result");
  add("branch_exclusive", "harbor_compact", "mutuallyExclusive", ["wardens", "salvagers"], "core", "계약판에는 한 인장만 들어가는 홈이 있다.", "npc_mira", "visual");
  add("branch_wardens", "wardens", "gives", "wardens_seal", "core", "수호대 계약 후 인양단 계약 칸이 봉인되었다.", "npc_hael", "result");
  add("branch_salvagers", "salvagers", "gives", "salvagers_mark", "core", "인양단 계약 후 수호대 계약 칸이 봉인되었다.", "npc_rato", "result");

  for (const rumor of input.rumors) {
    add("rumor_" + rumor.id, rumor.id, "claims", rumor.claimKo, "exception", "소문: " + rumor.claimKo, rumor.speakerNpcId, "dialogue");
    add("counter_" + rumor.id, rumor.id, "correctedByObservation", rumor.correctionKo, "exception", "검증 기록: " + rumor.correctionKo, rumor.id, "result");
  }

  add(
    "scenario_lamp_binder",
    "recipe_diving_lamp",
    "scenarioBinder",
    options.lampBinder,
    "core",
    "방수 시험 결과 이번 잠수등의 올바른 접합재는 " + (names.get(options.lampBinder) ?? options.lampBinder) + "다.",
    "npc_sena",
    "result",
  );
  add(
    "scenario_wisp_ward",
    "mire_wisp",
    "requiresItem",
    options.wispWard,
    "core",
    (names.get(options.wispWard) ?? options.wispWard) + "을 지니자 도깨비불이 가루를 남겼다.",
    "mire_wisp",
    "result",
  );
  add(
    "scenario_prism_catalyst",
    "recipe_star_prism",
    "scenarioCatalyst",
    options.prismCatalyst,
    "core",
    "굴절 시험에서 " + (names.get(options.prismCatalyst) ?? options.prismCatalyst) + "만 별빛을 한 점으로 모았다.",
    "npc_yeon",
    "result",
  );
  return { facts, evidenceCues };
}

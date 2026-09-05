import {
  sha256 as protocolSha256,
  validateNormalizedDocument,
} from "../../packages/atlas_protocol/src/index.mjs";
import {
  HIGH_ENTROPY, KEY_MACRO, PRIVATE_USE, URL_LIKE, ZERO_WIDTH_OR_BIDI,
  assertExact, assertString, deepFreeze, digestCanonical, fail,
} from "./core.mjs";
import { WikiWorkspace } from "./workspace.mjs";

const PREDICATE_LABEL = {
  "located-in": "위치",
  "connects-to": "연결",
  contains: "포함",
  "offered-by": "제공자",
  drops: "획득처",
  produces: "제작 결과",
  requires: "필요",
  rewards: "보상",
  "sold-by": "판매처",
  "exchanged-by": "교환처",
  "changes-state-to": "상태 변화",
  "appears-when": "등장 조건",
};
const VERB_LABEL = {
  "travel-to": "이동",
  "talk-to": "대화",
  inspect: "확인",
  acquire: "획득",
  craft: "제작",
  exchange: "교환",
  "use-item": "사용",
  "set-world-state": "환경 변경",
  "choose-branch": "분기 선택",
  "verify-outcome": "결과 확인",
};
const QUESTION_LABEL = {
  identity: "정체",
  source: "획득처",
  requirement: "조건",
  result: "결과",
  scope: "적용 범위",
  route: "경로",
};

function escapeMarkdown(value) {
  return String(value).replace(/([\\\x60*_{}\[\]()#+.!>|-])/g, "\\$1");
}

function entityLink(entity, pagePathById) {
  if (!entity) fail("renderer: unresolved approved entity link");
  const pagePath = pagePathById.get(entity.entityId);
  if (!pagePath) fail("renderer: unresolved page mapping");
  return `[${escapeMarkdown(entity.name)}](./${pagePath})`;
}

export function lintSafeMarkdown(markdown) {
  assertString(markdown, "markdown", { min: 1, max: 512 * 1024 });
  if (ZERO_WIDTH_OR_BIDI.test(markdown) || PRIVATE_USE.test(markdown)) {
    fail("markdown: hidden unicode forbidden");
  }
  if (URL_LIKE.test(markdown)) fail("markdown: external URL forbidden");
  if (/<!--|-->|<\/?[A-Za-z!][^>]*>|^---\s*$/mu.test(markdown)) {
    fail("markdown: HTML/comment/frontmatter forbidden");
  }
  if (/\x60{1,3}|~~~/u.test(markdown)) fail("markdown: code forbidden");
  if (KEY_MACRO.test(markdown)) fail("markdown: key macro forbidden");
  if (HIGH_ENTROPY.test(markdown)) fail("markdown: high-entropy token forbidden");
  const safeLinksRemoved = markdown.replace(/\[[^\]\n]+\]\(\.\/page-[0-9]{3,6}\.md\)/gu, "LINK");
  if (/\[[^\]]*\]\([^)]*\)/u.test(safeLinksRemoved) || /!\[/u.test(markdown)) {
    fail("markdown: only generated relative entity links are allowed");
  }
  for (const [index, line] of markdown.split("\n").entries()) {
    if (line === "") continue;
    if (/^#{1,3} [^#].+/u.test(line)) continue;
    if (/^- .+/u.test(line)) continue;
    if (/^[^#<>\x60]+$/u.test(line)) continue;
    fail(`markdown:${index + 1}: AST node is not allowed`);
  }
  return true;
}

function renderEntityPage(entity, graph, entityById, pagePathById) {
  const lines = [
    `# ${escapeMarkdown(entity.name)}`,
    "",
    `- 종류: ${escapeMarkdown(entity.type)}`,
  ];
  const claims = graph.claims.filter((claim) =>
    claim.status === "approved" && claim.subjectEntityId === entity.entityId);
  if (claims.length) {
    lines.push("", "## 확인된 사실", "");
    for (const claim of claims) {
      const object = claim.object.kind === "entity"
        ? entityLink(entityById.get(claim.object.entityId), pagePathById)
        : escapeMarkdown(claim.object.value);
      lines.push(`- ${escapeMarkdown(PREDICATE_LABEL[claim.predicate])}: ${object}`);
    }
  }
  const procedures = graph.procedures.filter((procedure) =>
    procedure.status === "approved"
    && procedure.steps.some((step) => step.targetEntityId === entity.entityId));
  if (procedures.length) {
    lines.push("", "## 확인된 절차", "");
    for (const procedure of procedures) {
      const number = procedure.procedureId.replace("procedure-", "");
      lines.push(`- 절차 ${escapeMarkdown(number)}`);
      for (const step of procedure.steps) {
        const target = step.targetEntityId
          ? `: ${entityLink(entityById.get(step.targetEntityId), pagePathById)}`
          : "";
        lines.push(`- ${step.order}단계 ${escapeMarkdown(VERB_LABEL[step.verb])}${target}`);
      }
    }
  }
  const unknowns = graph.unknowns.filter((item) =>
    item.status !== "resolved" && item.subjectEntityId === entity.entityId);
  if (unknowns.length) {
    lines.push("", "## 미확인", "");
    for (const item of unknowns) {
      lines.push(`- 추가 확인 필요: ${escapeMarkdown(QUESTION_LABEL[item.questionCode])}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderDeterministicWiki(graph) {
  assertExact(
    graph,
    ["schemaVersion", "evidence", "entities", "claims", "procedures", "contradictions", "unknowns", "reinspectionQueue"],
    [],
    "graph",
  );
  const approvedEntities = graph.entities.filter((entry) => entry.status === "approved");
  const entityById = new Map(approvedEntities.map((entry) => [entry.entityId, entry]));
  const pagePathById = new Map(approvedEntities.map((entry, index) => [
    entry.entityId,
    `page-${String(index + 1).padStart(3, "0")}.md`,
  ]));
  const pages = {};
  const indexLines = ["# 콘텐츠 인덱스", ""];
  for (const entity of approvedEntities) {
    indexLines.push(`- ${entityLink(entity, pagePathById)} — ${escapeMarkdown(entity.type)}`);
  }
  const openContradictions = graph.contradictions.filter((entry) => entry.status === "open");
  if (openContradictions.length) {
    indexLines.push("", "## 충돌", "", `- 해결되지 않은 충돌: ${openContradictions.length}`);
  }
  const openUnknowns = graph.unknowns.filter((entry) => entry.status !== "resolved");
  if (openUnknowns.length) {
    indexLines.push("", "## 미확인", "", `- 추가 조사가 필요한 항목: ${openUnknowns.length}`);
  }
  pages["index.md"] = `${indexLines.join("\n")}\n`;
  for (const entity of approvedEntities) {
    pages[pagePathById.get(entity.entityId)] = renderEntityPage(
      entity,
      graph,
      entityById,
      pagePathById,
    );
  }
  const orderedPages = Object.fromEntries(
    Object.entries(pages).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  );
  let totalBytes = 0;
  for (const [path, markdown] of Object.entries(orderedPages)) {
    lintSafeMarkdown(markdown);
    const bytes = Buffer.byteLength(markdown, "utf8");
    if (bytes > 24 * 1024) fail(`wiki.${path}: page exceeds 24 KiB`);
    totalBytes += bytes;
  }
  if (totalBytes > 512 * 1024) fail("wiki: output exceeds 512 KiB");
  return deepFreeze(orderedPages);
}

function normalizedPageTitle(entity) {
  return `${entity.type}: ${entity.name}`;
}

export function renderNormalizedDocument(graph) {
  assertExact(
    graph,
    ["schemaVersion", "evidence", "entities", "claims", "procedures", "contradictions", "unknowns", "reinspectionQueue"],
    [],
    "graph",
  );
  const approvedEntities = graph.entities.filter((entry) => entry.status === "approved");
  const entityById = new Map(approvedEntities.map((entry) => [entry.entityId, entry]));
  const pageTitleById = new Map(
    approvedEntities.map((entry) => [entry.entityId, normalizedPageTitle(entry)]),
  );
  const indexNodes = [{
    type: "heading",
    level: 1,
    text: "콘텐츠 인덱스",
  }];
  for (const entity of approvedEntities) {
    indexNodes.push({
      type: "link",
      label: entity.name,
      targetTitle: pageTitleById.get(entity.entityId),
    });
  }
  const unresolvedContradictions = graph.contradictions
    .filter((entry) => entry.status === "open").length;
  const unresolvedUnknowns = graph.unknowns
    .filter((entry) => entry.status !== "resolved").length;
  if (unresolvedContradictions > 0 || unresolvedUnknowns > 0) {
    indexNodes.push({
      type: "table",
      headers: ["구분", "수량"],
      rows: [
        ["해결되지 않은 충돌", String(unresolvedContradictions)],
        ["추가 조사가 필요한 항목", String(unresolvedUnknowns)],
      ],
    });
  }

  const pages = [{
    title: "콘텐츠 인덱스",
    nodes: indexNodes,
  }];
  for (const entity of approvedEntities) {
    const nodes = [
      { type: "heading", level: 1, text: entity.name },
      { type: "paragraph", text: `종류: ${entity.type}` },
    ];
    const claims = graph.claims.filter((claim) =>
      claim.status === "approved" && claim.subjectEntityId === entity.entityId);
    if (claims.length > 0) {
      nodes.push({ type: "heading", level: 2, text: "확인된 사실" });
      nodes.push({
        type: "table",
        headers: ["관계", "대상"],
        rows: claims.map((claim) => [
          PREDICATE_LABEL[claim.predicate],
          claim.object.kind === "entity"
            ? entityById.get(claim.object.entityId).name
            : claim.object.value,
        ]),
      });
      for (const claim of claims) {
        if (claim.object.kind === "entity") {
          const target = entityById.get(claim.object.entityId);
          nodes.push({
            type: "link",
            label: target.name,
            targetTitle: pageTitleById.get(target.entityId),
          });
        }
      }
    }
    const procedures = graph.procedures.filter((procedure) =>
      procedure.status === "approved"
      && procedure.steps.some((step) => step.targetEntityId === entity.entityId));
    if (procedures.length > 0) {
      nodes.push({ type: "heading", level: 2, text: "확인된 절차" });
      for (const procedure of procedures) {
        nodes.push({
          type: "list",
          ordered: true,
          items: procedure.steps.map((step) => {
            const target = step.targetEntityId
              ? entityById.get(step.targetEntityId).name
              : "대상 없음";
            return `${VERB_LABEL[step.verb]}: ${target}`;
          }),
        });
      }
    }
    const unknowns = graph.unknowns.filter((item) =>
      item.status !== "resolved" && item.subjectEntityId === entity.entityId);
    if (unknowns.length > 0) {
      nodes.push({ type: "heading", level: 2, text: "미확인" });
      nodes.push({
        type: "list",
        ordered: false,
        items: unknowns.map((item) =>
          `추가 확인 필요: ${QUESTION_LABEL[item.questionCode]}`),
      });
    }
    pages.push({
      title: pageTitleById.get(entity.entityId),
      nodes,
    });
  }

  const document = deepFreeze({
    schemaVersion: "atlas/normalized-document/1",
    pages,
  });
  let result;
  try {
    result = validateNormalizedDocument(document);
  } catch (error) {
    fail(`NormalizedDocument: validator threw: ${error.message}`);
  }
  if (!result || result.valid !== true || !Array.isArray(result.errors)
    || result.errors.length !== 0) {
    const errors = Array.isArray(result?.errors)
      ? result.errors.join("; ")
      : "malformed validator result";
    fail(`NormalizedDocument: ${errors}`);
  }
  return document;
}

export function buildWikiBundle(workspace) {
  if (!(workspace instanceof WikiWorkspace)) {
    fail("buildWikiBundle: WikiWorkspace required");
  }
  const graph = workspace.normalizedGraph();
  const pages = renderDeterministicWiki(graph);
  const normalizedDocument = renderNormalizedDocument(graph);
  const pageFiles = Object.entries(pages).map(([path, markdown]) => ({
    path,
    byteLength: Buffer.byteLength(markdown, "utf8"),
    sha256: protocolSha256(markdown),
  }));
  const inputEnvelopeDigests = [...new Set(
    graph.evidence.map((entry) => entry.artifactDigest),
  )].sort();
  const knowledgeReceipt = deepFreeze({
    schemaVersion: "1.0",
    inputEnvelopeDigests,
    graphDigest: digestCanonical(graph),
    approvedEntityDigest: digestCanonical(
      graph.entities.filter((entry) => entry.status === "approved"),
    ),
    approvedClaimDigest: digestCanonical(
      graph.claims.filter((entry) => entry.status === "approved"),
    ),
    approvedProcedureDigest: digestCanonical(
      graph.procedures.filter((entry) => entry.status === "approved"),
    ),
    rendererInputDigest: digestCanonical({
      graph,
      rendererVersion: "safe-ast-1",
    }),
    pagesDigest: digestCanonical(pageFiles),
    normalizedDocumentDigest: protocolSha256(normalizedDocument),
  });
  return deepFreeze({
    delivery: {
      schemaVersion: "1.0",
      rendererVersion: "safe-ast-1",
      pages,
    },
    normalizedDocument,
    knowledgeReceipt,
    reinspectionQueue: graph.reinspectionQueue,
  });
}

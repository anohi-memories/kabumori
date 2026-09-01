import {
  prepareNewsCandidate,
  type ImportantNewsCategory,
  type PreparedNewsCandidate,
} from "./news_candidate_logic.ts";

export const IMPORTANT_NEWS_GROUP_WINDOW_MS = 5 * 60 * 1000;

export type ImportantNewsEventFamily =
  | "earnings_bundle"
  | "ma_bundle"
  | "share_buyback"
  | "standalone";

export type ImportantNewsCandidateGroup = {
  key: string;
  eventFamily: ImportantNewsEventFamily;
  anchorPublishedAt: string;
  members: PreparedNewsCandidate[];
};

const EARNINGS_CATEGORIES = new Set<ImportantNewsCategory>([
  "earnings", "earnings_revision_up", "earnings_revision_down",
  "dividend_increase", "dividend_decrease", "no_dividend",
]);

const MA_CATEGORIES = new Set<ImportantNewsCategory>([
  "ma", "tob", "business_alliance", "capital_alliance",
]);

const GENERIC_EVENT_TOKENS = new Set([
  "株式会社", "合同会社", "company", "corporation", "holdings", "group",
  "公開買付け", "資本業務提携", "業務提携", "株式", "取得", "決議", "お知らせ",
]);

function normalized(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/gu, "").trim();
}

function sameIssuer(left: PreparedNewsCandidate, right: PreparedNewsCandidate): boolean {
  const leftCode = normalized(left.companyCode);
  const rightCode = normalized(right.companyCode);
  if (leftCode && rightCode) return leftCode === rightCode;

  const leftEntity = normalized(left.entityKey);
  const rightEntity = normalized(right.entityKey);
  if (leftEntity && rightEntity) return leftEntity === rightEntity;

  const leftName = normalized(left.companyName).replace(/株式会社|有限会社|合同会社/gu, "");
  const rightName = normalized(right.companyName).replace(/株式会社|有限会社|合同会社/gu, "");
  return Boolean(leftName && rightName && leftName === rightName);
}

export function importantNewsEventFamily(category: ImportantNewsCategory): ImportantNewsEventFamily {
  if (EARNINGS_CATEGORIES.has(category)) return "earnings_bundle";
  if (MA_CATEGORIES.has(category)) return "ma_bundle";
  if (category === "share_buyback") return "share_buyback";
  return "standalone";
}

function eventTokens(candidate: PreparedNewsCandidate): Set<string> {
  const ownNames = [candidate.companyName, candidate.companyCode, candidate.entityKey]
    .map(normalized).filter(Boolean);
  const text = `${candidate.title}\n${candidate.bodySummary ?? ""}`.normalize("NFKC");
  const tokens = text.match(/[A-Za-z][A-Za-z0-9&.-]{1,}|[一-龠々ァ-ヶー]{2,}/gu) ?? [];
  return new Set(tokens.map(normalized).filter((token) =>
    token.length >= 2 && !GENERIC_EVENT_TOKENS.has(token) &&
    !ownNames.some((own) => own === token || own.includes(token))
  ));
}

function hasSharedEventAnchor(left: PreparedNewsCandidate, right: PreparedNewsCandidate): boolean {
  const rightTokens = eventTokens(right);
  return Array.from(eventTokens(left)).some((token) => rightTokens.has(token));
}

export function belongsToSameImportantNewsEvent(
  left: PreparedNewsCandidate,
  right: PreparedNewsCandidate,
): boolean {
  if (!sameIssuer(left, right)) return false;
  const leftAt = Date.parse(left.publishedAt);
  const rightAt = Date.parse(right.publishedAt);
  if (!Number.isFinite(leftAt) || !Number.isFinite(rightAt) ||
    Math.abs(leftAt - rightAt) > IMPORTANT_NEWS_GROUP_WINDOW_MS) return false;

  const leftFamily = importantNewsEventFamily(left.category);
  const rightFamily = importantNewsEventFamily(right.category);
  if (leftFamily === "standalone" || leftFamily !== rightFamily) return false;
  if (leftFamily === "earnings_bundle" || leftFamily === "share_buyback") return true;
  return left.category === right.category || hasSharedEventAnchor(left, right);
}

function groupIdentity(candidate: PreparedNewsCandidate): string {
  return normalized(candidate.companyCode) || normalized(candidate.entityKey) || normalized(candidate.companyName);
}

export function groupImportantNewsCandidates(
  candidates: PreparedNewsCandidate[],
): ImportantNewsCandidateGroup[] {
  const sorted = [...candidates].sort((left, right) =>
    Date.parse(left.publishedAt) - Date.parse(right.publishedAt) || left.sourceUrl.localeCompare(right.sourceUrl)
  );
  const groups: ImportantNewsCandidateGroup[] = [];
  for (const candidate of sorted) {
    const family = importantNewsEventFamily(candidate.category);
    const group = groups.find((item) => {
      const anchor = item.members[0];
      return Date.parse(candidate.publishedAt) - Date.parse(item.anchorPublishedAt) <= IMPORTANT_NEWS_GROUP_WINDOW_MS &&
        belongsToSameImportantNewsEvent(anchor, candidate);
    });
    if (group) {
      group.members.push(candidate);
      continue;
    }
    groups.push({
      key: `${groupIdentity(candidate)}:${family}:${candidate.publishedAt}`,
      eventFamily: family,
      anchorPublishedAt: candidate.publishedAt,
      members: [candidate],
    });
  }
  return groups;
}

export async function aggregateImportantNewsGroup(group: ImportantNewsCandidateGroup): Promise<PreparedNewsCandidate> {
  const representative = group.members[0];
  if (group.members.length === 1) return representative;
  const bodySummary = group.members.map((member, index) => [
    `関連開示${index + 1}: ${member.title}`,
    `公開日時: ${member.publishedAt}`,
    `本文要約: ${member.bodySummary || "本文情報なし"}`,
    `出典: ${member.sourceUrl}`,
  ].join("\n")).join("\n\n");
  const title = group.members.map((member) => member.title).join(" / ");
  return await prepareNewsCandidate({
    ...representative,
    title,
    bodySummary,
  });
}

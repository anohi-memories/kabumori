import type { ImportantNewsCandidate } from "@/lib/important-news";

const PREVIEW_LENGTH = 180;

export function ImportantNewsCandidateList({
  candidates,
}: {
  candidates: ImportantNewsCandidate[];
}) {
  return (
    <ol className="important-news-list">
      {candidates.map((candidate) => {
        const isLongText = Boolean(
          candidate.generatedText && candidate.generatedText.length > PREVIEW_LENGTH,
        );
        const preview = isLongText
          ? `${candidate.generatedText?.slice(0, PREVIEW_LENGTH).trim()}…`
          : candidate.generatedText;

        return (
          <li
            className={`important-news-item important-news-${candidate.statusTone}`}
            key={candidate.id}
          >
            <div className="important-news-heading">
              <div>
                <strong>{candidate.title}</strong>
                <p className="important-news-time">{candidate.occurredAtLabel} JST</p>
              </div>
              <span className={`status status-${candidate.statusTone}`}>
                {candidate.statusLabel}
              </span>
            </div>

            {candidate.companyName ? (
              <p className="failure-company">{candidate.companyName}</p>
            ) : null}

            <p className="important-news-meta">
              重要度：
              <span className={`importance-badge importance-${candidate.importance}`}>
                {candidate.importanceLabel}
              </span>
            </p>

            {candidate.factStatusLabel ? (
              <CandidateCheckDetails
                label="Fact"
                status={candidate.factStatusLabel}
                issues={candidate.factIssues}
              />
            ) : null}
            {candidate.voiceStatusLabel ? (
              <CandidateCheckDetails
                label="Voice"
                status={candidate.voiceStatusLabel}
                issues={candidate.voiceIssues}
              />
            ) : null}

            {candidate.generationError ? (
              <div className="post-history-error">
                <p>{candidate.generationError}</p>
              </div>
            ) : null}

            {preview ? (
              <div className="post-history-text">
                <p>{preview}</p>
                {isLongText ? (
                  <details>
                    <summary>全文を見る</summary>
                    <p>{candidate.generatedText}</p>
                  </details>
                ) : null}
              </div>
            ) : null}

            <div className="important-news-links">
              {candidate.xPostId ? (
                <p className="important-news-meta">
                  X post ID：
                  {candidate.xPostUrl ? (
                    <a href={candidate.xPostUrl} target="_blank" rel="noreferrer">
                      {candidate.xPostId}
                    </a>
                  ) : (
                    <code>{candidate.xPostId}</code>
                  )}
                </p>
              ) : null}
              {candidate.sourceUrl ? (
                <p className="important-news-meta">
                  <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">
                    元記事を見る
                  </a>
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function CandidateCheckDetails({
  label,
  status,
  issues,
}: {
  label: string;
  status: string;
  issues: string[];
}) {
  return (
    <div className="failure-check">
      <p>
        <strong>{label}</strong>
        <span>{status}</span>
      </p>
      {issues.length > 0 ? (
        <ul>
          {issues.map((issue, index) => (
            <li key={`${label}-${index}`}>{issue}</li>
          ))}
        </ul>
      ) : status !== "問題なし" ? (
        <p className="failure-no-issues">詳細な指摘は記録されていません。</p>
      ) : null}
    </div>
  );
}

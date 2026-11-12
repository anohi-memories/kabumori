# G2-02 TASK 10: G1 PR #655 × G3 PR #653 (+ G5 PR #645) approval → reservation → notification, Simulator real taps

task_id: `postona-g2-gen2-10-g1-pr655-g3-pr653-approval-schedule-notification-simulator-integrated-qa-20261112`

The checks ran on a throwaway local tree: G1 #655 head `fedddba4` with G3 #653 head `77945386` merged in locally, on G1's own local
runtime (g1xs, 127.0.0.1 only). Flags were on only in that tree. Pins, runtime and device are in `env.txt`, and the flag edits are in `throwaway.diff`.
Nothing in this PR changes product source. It holds G2-owned QA evidence only.

Result: **20 PASS, 0 FAIL, 3 NOT_RUN**, plus **5 P3 findings**. Of the PASS items, 16 were real taps and 4 were HTTP/alternative measurements.

## Real taps (dedicated Simulator, kana keyboard active)

| # | What was done | Seen on screen | Server (throwaway DB) | Result |
|---|---|---|---|---|
| R1 | log in as A, open 設定 | entries 素材BOX / 投稿の承認 / お知らせ (`02`) | - | PASS |
| R2 | date typed with the long mark `2026ー11ー20 09:30` via kana keyboard, 承認に回す | red 「日時は『2026-11-01 09:30』の形で…」 (`03`) | no submit request, 0 candidates | PASS |
| R3 | full-width digits picked from the kana candidates (`６２０２２`), 承認に回す | same red message (`04`) | no submit request, 0 candidates | PASS |
| R4 | `2026-11-20 09:30` (ASCII keyboard), 承認に回す | green 承認待ち, card 版 1 (`05`) | submit 200; 1 candidate, 1 notification, 1 outbox | PASS |
| R5 | お知らせ: 未読 1件 → tap | opens the approval screen at that candidate (`06`,`07`) | markRead 200, read_at set | PASS |
| R6 | 承認する | 承認済み（予約に登録済み）, 版 2 (`08`) | approve 200; reservation 1, `approval_approved` | PASS |
| R7 | 予約の管理を開く, 戻る | 予約済み 2026-11-20 09:30 (`09`) | - | PASS |
| R8 | 却下する → 本当に却下する | first tap sends nothing (`11`), then 却下 版 2 (`12`) | reject 200 once | PASS |
| R9 | another session of A revises (版 1→2), then 承認する on the old screen | red 「ほかの操作で内容が変わっていました…」, card re-read to 版 2 / new hash (`14`,`15`) | approve 409 `POSTONA_RESV_STALE_REVISION`, get 200, nothing written | PASS |
| R10 | 修正する → `-v3` → 修正を保存 | 版 3, new hash (`19`) | revise 200 | PASS |
| R11 | X reconnect outside the app (G4 SQL, fake tokens), 承認する | generation text + 修正して承認に回し直す (`20`) → 版 4 (`21`) → 承認する → 承認済み 版 5 (`22`) | 409 `POSTONA_RESV_APPROVAL_GENERATION_CHANGED`, revise 200, approve 200, reservations 2 | PASS |
| R12 | person C becomes a second owner of A's workspace, 承認する; then C leaves, 承認する | red 「Xアカウントの接続を確認できないため…」 (`28`), after leave the generation text (`29`) | 403 `POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED`, then 409 generation; nothing written | PASS |
| R13 | gateway container stopped, 修正して承認に回し直す; gateway started, same button | yellow 「結果を確認できず…同じ操作として扱われ、二重には作られません」 (`30`), then 修正しました 版 2 (`31`) | down: no row; up: revise 200 once | PASS |
| R14 | A's X service ended (DB), 承認する; もう一度読み込む; 却下する ×2 | red 「X自動投稿の利用登録が有効でないため…表示していた内容は閉じました」 (`32`); reload shows the list; 却下 works (`35`) | approve 403 `POSTONA_RESV_SERVICE_NOT_ACTIVE`; list 200; reject 200 | PASS |
| R15 | A logs out, B logs in | login form, then B's own X only (`37`,`38`); 承認 0 candidates (`39`); お知らせ 0 (`40`) | B: 0 candidates / notifications / reservations | PASS |
| R16 | B logs out, A logs in again | empty form (B's address not kept); A sees 「このサービスは退会済みです」 (`41`) | no approval request was sent before the gate | PASS |

Typing lagged 15–25 s and the Mac load reached 120–170 from about 14:12 JST, caused by an app outside this task.
A few dropped characters were re-typed and checked on screen before each send. No result was taken from a script and called a tap.

## HTTP / alternative measurements (same runtime)

| # | What | Result |
|---|---|---|
| H1 | G1's real `parseJstInput` (unchanged file) on 18 inputs, `parse-alt.txt` / `parse-alt.mts` | 2 accepted (ASCII; ASCII + trailing U+3000, trimmed), 16 refused: full-width digits/minus, U+30FC, U+2014, U+2013, U+2212, U+FF0D, U+2011, U+3000 between date and time, U+FF1A, no space, slash, `T`, Arabic-Indic digits, Feb 30, past. PASS |
| H2 | B against A's items, `http-probe.txt` | B list of A's account 0, get/approve/reject/revise 404 `POSTONA_RESV_NOT_FOUND`, B notifications 0, no token 401, bad JWT 401. PASS |
| H3 | duplicates (person C), `dup-probe.txt` | same clientRequestId submitted 3× (2 in parallel) → 1 candidate / 1 notification / 1 outbox; approve 3× (2 in parallel) → 1 reservation / 1 `approval_approved`. PASS |
| H4 | after service end, `after-end-outside.txt` | list 200, notifications 200, submit 403 `POSTONA_RESV_SERVICE_NOT_ACTIVE`. PASS |

Final rows and every app request in order: `server-final.txt`. Ownership join/leave log: `join.txt`. Crash check: `crash-check.txt` (0 crash reports, 0 red screens).

## NOT_RUN

- N1: the flag-OFF build with "0 approval requests" was not built and tapped. Alternative evidence: the default at `fedddba4` is
  `POSTONA_APPROVAL_UI_ENABLED = false` (source read), and G1's runner covers the OFF path. A G2 measurement of this is still missing.
- N2: 素材BOX was not opened in this TASK; only its entry was seen (`02`). It was covered in TASK 8.
- N3: real push. Outbox rows are written, but nothing sends them here. Push is not verified.

## P3 findings (returned to the owners, no source changed by G2)

1. **G1: notifications are not grouped per candidate.** G3 #19 (`docs/postona/g3-approval-notification-contract-20261105.md` §5a) asks G1 to show only the newest
   `approval_requested` per candidate as unread. On screen, candidate `fb8713ac` shows four 「承認待ちになりました」 rows, three of them 未読, and the badge says 未読 8件 (`24`).
   Opening one marks only that row read. Proposal: group by `candidateId`, show the newest row, and mark the older rows of that candidate read when it is opened.
2. **G1: date input with the Japanese keyboard.** Wrong input is refused safely before sending (R2, R3, H1). But on the kana keyboard a valid date is hard to type:
   the space disappears and full-width candidates come first. Minimal proposal that keeps the parser unchanged: on the date field set `keyboardType="numbers-and-punctuation"`,
   `autoCorrect={false}` and `autoCapitalize="none"`, and add 「半角の数字と - と : で」 to the message. Optional and for G1 to decide: NFKC plus dash folding before the same regex.
3. **G1/G3 wording: second owner → "reconnect X".** With a second owner on the personal workspace, approve answers 403 `POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED`.
   The screen then says to reconnect X (`28`), which would not help, because the cause is the ownership change. A distinct code or text for that case would be clearer.
4. **G1: reads after service end.** G3's contract keeps list/notifications readable after the end (H4 200). In the app, the read-only list is reachable before
   a re-login (R14). After a re-login, A sees only the 退会済み gate (R16). Is that intended?
5. **Observation, cause not investigated:** right after B's login, B's X shows 接続記録あり・未確認 (`38`), although B was connected through G4's SQL with fake tokens.
   This needs a look by G4/G1. G2 makes no claim about the cause.

## Safety

- Only local: 127.0.0.1 (56521 / 8081) and the throwaway Podman runtime g1xs. No production, managed or hosted read/write. No real X/Threads/Meta/OAuth/Push/paid API.
  No EAS, no signing, no merge, no deploy, no main push.
- Product flags stayed OFF in source. They were turned on only in the throwaway tree, which was never pushed.
- G4/G5/G3 originals were not edited. The G5 lock trigger existed only in the throwaway PG17.
- Other slots' simulators, worktrees, Metro and Podman projects were not touched.
- Fake people only. Their login values are not in this PR, the REPORT or any picture.

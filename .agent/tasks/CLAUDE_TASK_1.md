# Claude Task 1

- task_id: morning-greeting-tone-image-variety-20260908
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- review_status: changes_required

## K1 review result

Commit `ff9dcc5b41595c31b7cd8d587ec1519f83e2791f` is **not approved yet**.

The text-tone changes and the root-cause analysis for repetitive images are directionally correct, and the regression suite reported 338 passing tests. However, the image diversification implementation violates the task's explicit quality constraint that each generated image must form a coherent natural scene rather than independently combining random-looking axes.

## Blocking issue

`morning_greeting_scene_logic.ts` independently rotates `location`, `activity`, `prop`, `camera_angle`, `framing`, etc. This creates semantically inconsistent combinations in the task's own 14-day dry plan, for example:

- `キッチン` + `洗濯物を干す`
- `洗面所の鏡の前` + `読書をする`
- `住宅街の朝の道` + `読書をする`
- `近所の公園` + `靴を履いて出かける準備をする`
- `玄関` + `カーテンを開ける`
- `リビングの窓際` + `朝食を作る`

This can produce strange or low-quality image prompts even though numeric diversity tests pass.

## Required correction

1. Preserve the successful text-policy changes from `ff9dcc5` unless a test requires adjustment.
2. Replace independent location/activity/prop random-axis composition with **coherent scene templates or compatibility-constrained selection**.
   - A scene should define a natural location + activity + compatible dominant prop as one unit, e.g.:
     - balcony + stretch + no/morning towel
     - residential street + morning walk + tote/umbrella
     - park + walk/stretch + water bottle
     - entrance + shoes/getting ready + tote/umbrella
     - kitchen + breakfast cooking + food/kitchen utensil
     - living room + reading + book
     - laundry area/balcony + hanging laundry + laundry basket
     - plants/balcony + watering + watering can
   - camera/framing/expression/outfit/lighting may continue rotating independently when compatible.
3. Keep strong anti-repeat behavior:
   - no same main scene two consecutive days
   - no mug on consecutive days
   - avoid repeated `window + plants + mug + front-facing upper body`
   - avoid exact 7-day whole-scene repetition
4. Special-day/seasonal themes must remain coherent with the anchored scene.
5. Add semantic-coherence tests, not only uniqueness tests.
   - At minimum assert that known incompatible location/activity pairs cannot occur.
   - Generate at least 14 consecutive dry plans and manually/structurally verify every plan is a plausible single scene.
6. Keep DB migration, production deploy, X posting, Cron, secrets, posting_windows changes prohibited.
7. Do not touch Codex current task or Claude slot2 task.

## Acceptance criteria

- Morning greeting text remains non-market-first and natural.
- Every 14-day dry scene-plan entry is semantically coherent.
- Diversity requirements remain satisfied without nonsensical combinations.
- Existing morning_greeting safety gates remain unchanged.
- Full `x-test-post` regression passes.
- No production changes.

## Completion

When corrected:
- set `status: review_required`
- set `next_owner: chatgpt`
- append a fresh `## Report` including changed files, coherence design, 14-day dry plan, tests, commit hash, and production unchanged.

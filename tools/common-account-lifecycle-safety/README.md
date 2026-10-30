# common-account-lifecycle-safety（G5 Phase 3i）

アカウント閉鎖の**判定ロジック**（提案）と、その合成データでのオフライン回帰テストです。
何にも接続せず、何も配線していません。設計は `docs/common-account/phase3i-lifecycle-safety-design.md` にあります。

- `protocol.ts` — `decide(facts)`（事実だけから次の動作を決める純粋関数）、データ面のゲート `gate()`、孤児スイーパー `findOrphans()`、境界の確認から主張できる不変条件を計算する `claimedInvariants()`
- `world.ts` — Phase 3h の観測（F1〜F4・F6）を、攻撃側の動作としてモデル化した合成の世界と、不変条件の検査 `violations()`
- `protocol_test.ts` — 決定表の回帰（境界・事実・時間・封じ込め・プロバイダ・削除・検証・ゲート・スイーパー）
- `invariants_test.ts` — 最大 2 つの割り込みを 12 の判定点へ入れる全組合せの探索と、負の対照
- `static_test.ts` — ネットワーク・環境変数・時計・乱数などに触れないことの確認
- `mutations.py` — 32 件の欠陥を 1 つずつ入れて、テストが検出することの確認（作業ツリーは変更しない）

```bash
deno test --no-config --allow-read tools/common-account-lifecycle-safety/
python3 tools/common-account-lifecycle-safety/mutations.py
```

これらは**提案したロジックのテスト**であり、managed Supabase の挙動の証明ではありません。

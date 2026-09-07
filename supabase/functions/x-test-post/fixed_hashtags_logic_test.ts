import assert from "node:assert/strict";
import test from "node:test";
import {
  KABUMORI_REPORT_FIXED_HASHTAGS,
  appendKabumoriReportFixedHashtags,
  hasKabumoriReportFixedHashtagsExactlyOnce,
} from "./fixed_hashtags_logic.ts";

test("the fixed hashtag string is exactly the 4 tags in order", () => {
  assert.equal(KABUMORI_REPORT_FIXED_HASHTAGS, "#日本株 #日経平均 #株式投資 #かぶモリ");
});

test("appendKabumoriReportFixedHashtags adds exactly one blank line then the tags", () => {
  const result = appendKabumoriReportFixedHashtags("本文の最後の行です。");
  assert.equal(result, "本文の最後の行です。\n\n#日本株 #日経平均 #株式投資 #かぶモリ");
});

test("appendKabumoriReportFixedHashtags trims trailing whitespace before appending", () => {
  const result = appendKabumoriReportFixedHashtags("本文です。\n\n  ");
  assert.equal(result, "本文です。\n\n#日本株 #日経平均 #株式投資 #かぶモリ");
});

test("hasKabumoriReportFixedHashtagsExactlyOnce is true only when the text ends with exactly the 4 tags, each once", () => {
  assert.equal(
    hasKabumoriReportFixedHashtagsExactlyOnce("本文\n\n#日本株 #日経平均 #株式投資 #かぶモリ"),
    true,
  );
  assert.equal(hasKabumoriReportFixedHashtagsExactlyOnce("本文だけでタグなし"), false);
  assert.equal(
    hasKabumoriReportFixedHashtagsExactlyOnce("#日本株 #日経平均 #株式投資 #かぶモリ\n\n本文が後にある"),
    false,
  );
});

test("hasKabumoriReportFixedHashtagsExactlyOnce rejects a duplicated tag even if the text still ends correctly", () => {
  const duplicated = "本文\n\n#日本株 #日本株 #日経平均 #株式投資 #かぶモリ";
  assert.equal(hasKabumoriReportFixedHashtagsExactlyOnce(duplicated), false);
});

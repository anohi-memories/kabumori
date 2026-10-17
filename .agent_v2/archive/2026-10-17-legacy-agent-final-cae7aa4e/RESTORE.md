# 復元の手順

1. このディレクトリで `shasum -a 256 -c SHA256SUMS` を実行し、全行が OK になることを確かめる。
2. `MANIFEST.json` の `files` を読み、各 `archive_path` のファイルを、**新しい空のディレクトリ**の下の `original_path` へコピーする。稼働中のcheckoutやslotのworktreeへは復元しない。
3. 復元した各ファイルについて、サイズ・SHA256・`git hash-object` の値が、MANIFESTの `size` / `sha256` / `git_blob` と一致することを確かめる。
4. 元commit `cae7aa4e8d90dc58b314dec5430187ddbb7fda08` の同じパスのblobと、バイト単位で一致することを確かめる（`git cat-file blob cae7aa4e8d90dc58b314dec5430187ddbb7fda08:<original_path>`）。

このsnapshotは追記のみ。内容を直す必要があれば、このディレクトリを書き換えずに、新しいsnapshotを別のディレクトリに作る。

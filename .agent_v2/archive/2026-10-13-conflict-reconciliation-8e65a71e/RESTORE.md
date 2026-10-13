# 復元手順

1. このarchiveのSHA256SUMSを、記載されたrepo相対pathで照合する。
2. 空の作業ディレクトリに、MANIFEST.jsonのfilesからarchive_pathをoriginal_pathへコピーする。現在のcheckoutへ直接上書きしない。
3. size/SHA256を照合し、source commit `8e65a71e3dc7b144ec511fa853ffe08e522dc827`の同original_pathのGit blob/バイト列と比較する。
4. CURRENT_STATE v2とFULL_MIGRATION TASKの2ファイルが一致することを確認する。実測結果はRESTORE_RESULT.json。
5. 前回旧.agent/共有文書/PR10/11/161原文を戻す場合は、前回final-migration-preflight-b7ce2c4fのMANIFEST/RESTOREを使う。本保存物には連結/置換しない。

PRやTASKの古いreview_required/ready、過去の完了返却先を現在状態として復活させる目的では使用しない。caller認証の現時点の安全性、managed owner、production、正式昇格は本復元で検証した扱いにしない。

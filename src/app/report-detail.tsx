// Root-stack report detail, used when a report is opened from outside the レポート tab (the portfolio's AI
// card and 「詳しく見る」). It is the very same screen as the nested `(tabs)/reports/[id]` route -- one
// implementation, no copy to drift -- but because it sits on the ROOT stack, the native edge swipe and the
// header's back button pop straight to the screen it was opened from (the portfolio) instead of revealing the
// レポート tab's list. The レポート tab itself keeps opening its nested route, so there the same swipe/back
// returns to the reports list. A direct open without a back stack falls back to the reports list (the screen's
// own 一覧へ戻る button), and `/reports/<id>` links keep working unchanged.
import ReportDetailScreen from './(tabs)/reports/[id]';

export default ReportDetailScreen;

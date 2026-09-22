import { Redirect } from 'expo-router';

/** Compatibility route: stock search now lives on the 銘柄 screen. */
export default function StockSearchRedirect() {
  return <Redirect href={{ pathname: '/explore', params: { focus: 'search' } }} />;
}

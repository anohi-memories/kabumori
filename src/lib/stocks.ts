export type TrackingType = 'holding' | 'watch';

export type StockMaster = {
  id: string;
  ticker_code: string;
  company_name: string;
  market: string;
};

export type TrackedStock = {
  id: string;
  user_id: string;
  stock_id: string;
  tracking_type: TrackingType;
  quantity: number | null;
  average_price: number | null;
  position_type: 'cash' | 'margin' | null;
  side: 'long' | 'short' | null;
  target_buy_price: number | null;
  target_sell_price: number | null;
  memo: string | null;
  stocks_master: StockMaster;
};

export type TrackedStockInput = Pick<
  TrackedStock,
  | 'tracking_type'
  | 'quantity'
  | 'average_price'
  | 'position_type'
  | 'side'
  | 'target_buy_price'
  | 'target_sell_price'
  | 'memo'
>;

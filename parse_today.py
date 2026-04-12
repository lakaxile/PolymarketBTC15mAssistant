import pandas as pd
import sys

def parse_logs(file_path):
    try:
        df = pd.read_csv(file_path)
    except Exception as e:
        print("Error reading log:", e)
        return
        
    df['Time'] = pd.to_datetime(df['Time'])
    today = pd.Timestamp.now().floor('D')
    
    # filter for today
    df_today = df[df['Time'].dt.date == today.date()]
    
    if df_today.empty:
        print("今天没有记录到任何交易。")
        return
    
    # The early bug might have logged multiple OPENED lines for the same market
    # However, each market should logically only have one WIN or LOSS.
    # To get accurate stats, we filter out OPENED and just look at settled trades.
    settled_trades = df_today[df_today['Result'].isin(['WIN', 'LOSS'])]
    
    total_trades = len(settled_trades)
    wins = len(settled_trades[settled_trades['Result'] == 'WIN'])
    losses = len(settled_trades[settled_trades['Result'] == 'LOSS'])
    total_profit = settled_trades['Profit'].sum()
    
    print(f"=== 今天 ({today.date()}) 已结算交易统计 ===")
    print(f"总计结算单数: {total_trades}")
    print(f"胜场: {wins}")
    print(f"负场: {losses}")
    print(f"胜率: {(wins/total_trades*100):.2f}%" if total_trades > 0 else "胜率: N/A")
    print(f"总盈亏: ${total_profit:.2f}")
    
    # We will display the last 15 settled trades to not spam the terminal, or all if < 15
    print("\n=== 最近结算记录 ===")
    for index, row in settled_trades.tail(15).iterrows():
        print(f"[{row['Time'].strftime('%H:%M:%S')}] {row['Side']:>4} | 原价: {row['EntryPrice']:.2f} | 目标: {row['PTB']:.2f} | {row['Result']} | 净利: {row['Profit']:>6.2f} | 余额: {row['Balance']:.2f} | {row['Question']}")

if __name__ == "__main__":
    parse_logs("./logs/simulation_trades.csv")

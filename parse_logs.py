import pandas as pd
import sys

def parse_logs(file_path):
    try:
        df = pd.read_csv(file_path)
    except FileNotFoundError:
        print("Log file not found.")
        return
    except pd.errors.EmptyDataError:
        print("Log file is empty.")
        return
        
    df['Time'] = pd.to_datetime(df['Time'])
    yesterday = pd.Timestamp.now().floor('D') - pd.Timedelta(days=1)
    
    # filter for yesterday
    df_yesterday = df[df['Time'].dt.date == yesterday.date()]
    
    if df_yesterday.empty:
        print("昨天没有记录到任何交易。")
        return
        
    total_trades = len(df_yesterday[df_yesterday['Result'] != 'OPENED'])
    wins = len(df_yesterday[df_yesterday['Result'] == 'WIN'])
    losses = len(df_yesterday[df_yesterday['Result'] == 'LOSS'])
    total_profit = df_yesterday[df_yesterday['Result'] != 'OPENED']['Profit'].sum()
    
    print(f"=== 昨天 ({yesterday.date()}) 交易统计 ===")
    print(f"总计结算单数: {total_trades}")
    print(f"胜场: {wins}")
    print(f"负场: {losses}")
    print(f"胜率: {(wins/total_trades*100):.2f}%" if total_trades > 0 else "胜率: N/A")
    print(f"总盈亏: ${total_profit:.2f}")
    print("\n=== 具体记录 ===")
    for index, row in df_yesterday.iterrows():
        print(f"[{row['Time']}] 市场: {row['Question']} | 方向: {row['Side']} | 价格: {row['EntryPrice']} | 结果: {row['Result']} | 盈亏: {row['Profit']} | 余额: {row['Balance']}")

if __name__ == "__main__":
    if len(sys.argv) > 1:
        parse_logs(sys.argv[1])
    else:
        parse_logs("./logs/simulation_trades.csv")

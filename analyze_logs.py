import pandas as pd

def analyze():
    df = pd.read_csv("./logs/simulation_trades.csv")
    df['Time'] = pd.to_datetime(df['Time'])
    
    # Target window: 2026-02-23 08:15:00 to 2026-02-23 11:15:00
    start = pd.to_datetime("2026-02-23 08:15:00")
    end = pd.to_datetime("2026-02-23 11:16:00")
    mask = (df['Time'] >= start) & (df['Time'] <= end)
    segment = df[mask].copy()
    
    # Filter settled trades
    settled = segment[segment['Result'].isin(['WIN', 'LOSS'])]
    
    print(f"=== Analysis Window: 08:15 - 11:15 (Total Settled: {len(settled)}) ===")
    
    # Overall and per strategy stats
    strategies = ["EDGE", "STRATEGY_2_PREMIUM", "STRATEGY_1"]
    for strat in strategies:
        s_df = settled[settled['Strategy'] == strat]
        if s_df.empty: continue
        total = len(s_df)
        wins = len(s_df[s_df['Result'] == 'WIN'])
        win_rate = (wins/total)*100
        profit = s_df['Profit'].sum()
        print(f"Strategy: {strat:20} | Trades: {total:2} | WinRate: {win_rate:6.2f}% | Profit: ${profit:8.2f}")

    print("\n--- Chronological Log of Key Movements ---")
    # Group by MarketID to see if multi-strategy entries hit or missed together
    for tid, group in segment.groupby('MarketID'):
        # Sort by Time
        group = group.sort_values('Time')
        q = group['Question'].iloc[0]
        # Summarize results for this market
        results = []
        for _, row in group.iterrows():
            if row['Result'] in ['WIN', 'LOSS']:
                results.append(f"{row['Strategy']}({row['Side']}):{row['Result']}@${row['Profit']}")
            elif row['Result'] == 'OPENED':
                pass # Already listed in settled usually
        if results:
            print(f"Market: {q}")
            print(f"  Result: {' | '.join(results)}")

if __name__ == "__main__":
    analyze()

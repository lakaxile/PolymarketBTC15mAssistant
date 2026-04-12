import pandas as pd

def calculate_ratios():
    try:
        df = pd.read_csv("./logs/simulation_trades.csv")
    except Exception as e:
        print(f"Error reading file: {e}")
        return

    # Filter only settled trades
    settled = df[df['Result'].isin(['WIN', 'LOSS', 'SCALPED'])].copy()
    
    # Identify unique strategies
    strategies = settled['Strategy'].unique()
    
    results = []
    
    for strat in strategies:
        s_df = settled[settled['Strategy'] == strat]
        total_trades = len(s_df)
        wins = s_df[s_df['Result'] == 'WIN']
        losses = s_df[s_df['Result'] == 'LOSS']
        
        num_wins = len(wins)
        num_losses = len(losses)
        
        avg_win = wins['Profit'].mean() if num_wins > 0 else 0
        # In our logs, Loss Profit is negative. We want the magnitude for the ratio.
        avg_loss = abs(losses['Profit'].mean()) if num_losses > 0 else 0
        
        pl_ratio = avg_win / avg_loss if avg_loss > 0 else float('inf')
        win_rate = (num_wins / total_trades) * 100 if total_trades > 0 else 0
        total_profit = s_df['Profit'].sum()
        
        results.append({
            "Strategy": strat,
            "Total": total_trades,
            "WinRate": f"{win_rate:.2f}%",
            "AvgWin": f"${avg_win:.2f}",
            "AvgLoss": f"${avg_loss:.2f}",
            "PL_Ratio": f"{pl_ratio:.2f}",
            "NetProfit": f"${total_profit:.2f}"
        })
    
    report = pd.DataFrame(results)
    print(report.to_string(index=False))

if __name__ == "__main__":
    calculate_ratios()

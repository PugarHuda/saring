"""Smallest checks for the logic that decides 'conflict'. Run: python test_conflict.py"""
from conflict_report import safe_of, position_at, vote_side, E18

# real pair verified on-chain (Safe.getOwners() == voter)
assert safe_of('0xacb1a67a4725c7433d238dbad292fdae839d6272') == '0xbcb6ebb4368dd51722d68d25c740cde2ef5fc7c9'
assert vote_side(str(E18)) == 0 and vote_side('0') == 1 and vote_side(str(E18 // 2)) == '50-50'
acts = [{'conditionId': 'c', 'type': 'TRADE', 'side': 'BUY', 'outcomeIndex': 0, 'size': 10, 'usdcSize': 4, 'timestamp': 100},
        {'conditionId': 'c', 'type': 'TRADE', 'side': 'SELL', 'outcomeIndex': 0, 'size': 3, 'usdcSize': 2, 'timestamp': 150},
        {'conditionId': 'c', 'type': 'TRADE', 'side': 'BUY', 'outcomeIndex': 1, 'size': 50, 'usdcSize': 5, 'timestamp': 300},  # after cutoff
        {'conditionId': 'c', 'type': 'REDEEM', 'side': '', 'outcomeIndex': 0, 'size': 7, 'usdcSize': 7, 'timestamp': 400}]
held, cost, n, redeemed = position_at(acts, 'c', 200)
assert held == {0: 7.0} and cost == 2.0 and n == 2 and redeemed
print('ok')

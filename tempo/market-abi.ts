// Generated from contracts/out (forge build). Do not edit.
export const marketAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "token_",
        "type": "address",
        "internalType": "contract IERC20"
      },
      {
        "name": "relayer_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "wormhole_",
        "type": "address",
        "internalType": "contract IWormhole"
      },
      {
        "name": "emitter_",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "DOMAIN_SEPARATOR",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "SOLANA_CHAIN_ID",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint16",
        "internalType": "uint16"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "VERDICT_TYPEHASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "bet",
    "inputs": [
      {
        "name": "court",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "yes",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "claim",
    "inputs": [
      {
        "name": "court",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "claimable",
    "inputs": [
      {
        "name": "court",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "who",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "markets",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "yesPool",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "noPool",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "outcome",
        "type": "uint8",
        "internalType": "enum SaringMarket.Outcome"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "noStake",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "relayer",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "saringEmitter",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "settle",
    "inputs": [
      {
        "name": "v",
        "type": "tuple",
        "internalType": "struct SaringWormhole.Verdict",
        "components": [
          {
            "name": "court",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "yes",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "no",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "excluded",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "incomplete",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "resolvedSlot",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "sigV",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "r",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "s",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "settleWithVaa",
    "inputs": [
      {
        "name": "vaa",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "token",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "verdictDigest",
    "inputs": [
      {
        "name": "v",
        "type": "tuple",
        "internalType": "struct SaringWormhole.Verdict",
        "components": [
          {
            "name": "court",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "yes",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "no",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "excluded",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "incomplete",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "resolvedSlot",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "verdictFromVaa",
    "inputs": [
      {
        "name": "vaa",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "v",
        "type": "tuple",
        "internalType": "struct SaringWormhole.Verdict",
        "components": [
          {
            "name": "court",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "yes",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "no",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "excluded",
            "type": "uint8",
            "internalType": "uint8"
          },
          {
            "name": "incomplete",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "resolvedSlot",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "wormhole",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IWormhole"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "yesStake",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "Bet",
    "inputs": [
      {
        "name": "court",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "bettor",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "yes",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Claimed",
    "inputs": [
      {
        "name": "court",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "bettor",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Settled",
    "inputs": [
      {
        "name": "court",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "outcome",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum SaringMarket.Outcome"
      },
      {
        "name": "yes",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "no",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "excluded",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "incomplete",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      },
      {
        "name": "resolvedSlot",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "BadPayload",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadVaa",
    "inputs": [
      {
        "name": "reason",
        "type": "string",
        "internalType": "string"
      }
    ]
  },
  {
    "type": "error",
    "name": "MarketClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotSettled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NothingToClaim",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TransferFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongEmitter",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAmount",
    "inputs": []
  }
] as const;

#!/usr/bin/env python3
"""起動スタブの入口（実行側）。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from g10runner import stub  # noqa: E402

if __name__ == "__main__":
    sys.exit(stub.main())

#!/usr/bin/env python3
"""全テストの実行: python3 tools/phase2_g10/run_tests.py [-v] [パターン]"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "tests"))


def main():
    args = sys.argv[1:]
    verbosity = 2 if "-v" in args else 1
    patterns = [a for a in args if a != "-v"]
    loader = unittest.TestLoader()
    if patterns:
        suite = unittest.TestSuite(loader.loadTestsFromName(p) for p in patterns)
    else:
        suite = loader.discover(os.path.join(HERE, "tests"), pattern="test_*.py", top_level_dir=os.path.join(HERE, "tests"))
    result = unittest.TextTestRunner(verbosity=verbosity).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())

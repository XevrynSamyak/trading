"""
python -m arbbot <command>

  start            run the bot in the MODE set in .env (paper by default)
  paper            run the bot in paper mode (nothing is ever sent)
  micro            run tiny capped real trades (needs LIVE_TRADING_CONFIRM=yes)
  check            confirm RPC, Jupiter, wallet and settings work
  status           one-time progress screen
  watch            progress screen that refreshes every 5 s
  report           what happened, kept apart by basis, plus the go-live verdict
  backtest         replay recorded opportunities under other rules (--mode=paper)
  benchmark        measure RPC / Jupiter / WebSocket latency from this device
  stop-trading     emergency stop (optional reason)
  enable-trading   re-enable trading after checking why it stopped
"""

import os
import sys

from .log import install_output_redaction, log


def _cfg():
    from .config import load_config

    return load_config()


def main(argv: list[str]) -> int:
    install_output_redaction()
    cmd, rest = (argv[0], argv[1:]) if argv else ("", [])
    if cmd in ("start", "paper", "micro"):
        if cmd != "start":
            os.environ["MODE"] = cmd
        from . import engine

        return engine.main()
    if cmd in ("status", "watch", "report", "backtest", "benchmark", "check", "stop-trading", "enable-trading"):
        try:
            _cfg()  # settings errors become one clear line, not a traceback
        except ValueError as err:
            log.error(f"Refusing to start: {err}")
            return 2
    if cmd in ("status", "watch"):
        from .status import main as status_main

        status_main(_cfg, watch=cmd == "watch" or "--watch" in rest)
        return 0
    if cmd == "report":
        from .report import main as report_main

        report_main(_cfg)
        return 0
    if cmd == "backtest":
        from .backtest import main as backtest_main

        backtest_main(_cfg, rest)
        return 0
    if cmd == "benchmark":
        from .benchmark import main as benchmark_main

        return benchmark_main(_cfg)
    if cmd == "check":
        from .check import main as check_main

        return check_main(_cfg)
    if cmd == "stop-trading":
        from .control import stop

        stop(_cfg(), " ".join(rest))
        return 0
    if cmd == "enable-trading":
        from .control import enable

        enable(_cfg())
        return 0
    print(__doc__.strip())
    return 0 if cmd in ("-h", "--help", "help") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

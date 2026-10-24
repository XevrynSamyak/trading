"""
stop-trading [reason]   emergency stop: the bot stops trading at once
enable-trading          manual re-activation after checking why it stopped
"""

from .killswitch import disable_trading, enable_trading, trading_disabled


def stop(cfg, reason: str) -> None:
    disable_trading(cfg.data_dir, reason or "stopped by hand (npm run stop-trading)")
    print("TRADING DISABLED. The bot stops trading within a few seconds. Re-enable with: npm run enable-trading")


def enable(cfg) -> None:
    was = trading_disabled(cfg.data_dir)
    if enable_trading(cfg.data_dir):
        print(f"Trading re-enabled. It had been disabled because: {was}")
    else:
        print("Trading was not disabled; nothing to do.")

import pytest

from arbbot.check import limits_line
from arbbot.config import DEFAULT_TOKENS, SOL_MINT, USDC_MINT, USDT_MINT, load_config
from arbbot.cycle import two_leg_spec
from arbbot.triangles import triangle_specs


def test_usdc_is_the_default_base():
    cfg = load_config({})
    assert (cfg.base_token, cfg.base_mint) == ("USDC", USDC_MINT)
    assert cfg.tokens == DEFAULT_TOKENS and cfg.tokens["USDT"] == USDT_MINT
    assert "of the USDC on hand" in limits_line(cfg)


def test_trading_in_usdt_swaps_the_pegged_stablecoin():
    cfg = load_config({"BASE_TOKEN": "usdt"})
    assert (cfg.base_token, cfg.base_mint) == ("USDT", USDT_MINT)
    assert "USDT" not in cfg.tokens and USDT_MINT not in cfg.tokens.values()
    assert cfg.tokens["USDC"] == USDC_MINT  # USDT -> USDC -> USDT watches for a depeg
    assert list(cfg.tokens)[:6] == ["SOL", "JUP", "BONK", "WIF", "JTO", "RAY"]
    assert "of the USDT on hand" in limits_line(cfg)


def test_a_custom_token_list_never_trades_the_base_against_itself():
    cfg = load_config({"BASE_TOKEN": "USDT", "TOKENS": f"SOL:{SOL_MINT},USDT:{USDT_MINT}"})
    assert cfg.tokens == {"SOL": SOL_MINT}


def test_only_usdc_or_usdt():
    with pytest.raises(ValueError, match="BASE_TOKEN must be USDC or USDT"):
        load_config({"BASE_TOKEN": "DAI"})


def test_cycles_start_and_end_in_the_base():
    assert two_leg_spec("SOL", SOL_MINT, USDT_MINT).path == [USDT_MINT, SOL_MINT, USDT_MINT]
    specs = triangle_specs({"SOL": SOL_MINT, "JUP": "jup"}, "SOL", USDT_MINT)
    assert all(s.path[0] == s.path[-1] == USDT_MINT for s in specs) and len(specs) == 2

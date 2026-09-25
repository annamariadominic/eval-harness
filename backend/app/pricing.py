"""Token pricing and cost estimation.

Prices live in a JSON file (``pricing.json`` by default, see ``EVAL_HARNESS_PRICING_FILE``)
rather than in code. A model without an entry yields ``None`` — the UI shows "no pricing" —
so costs are never invented.
"""

import json
from dataclasses import dataclass
from pathlib import Path

TOKENS_PER_UNIT = 1_000_000


@dataclass(frozen=True)
class ModelPrice:
    provider: str
    model: str
    input_per_mtok: float
    output_per_mtok: float


class PricingTable:
    def __init__(self, prices: list[ModelPrice]) -> None:
        self._prices = {(p.provider, p.model): p for p in prices}

    @classmethod
    def from_file(cls, path: Path) -> "PricingTable":
        if not path.exists():
            return cls([])
        data = json.loads(path.read_text())
        return cls(
            [
                ModelPrice(
                    provider=entry["provider"],
                    model=entry["model"],
                    input_per_mtok=float(entry["input_per_mtok"]),
                    output_per_mtok=float(entry["output_per_mtok"]),
                )
                for entry in data.get("models", [])
            ]
        )

    def lookup(self, provider: str, model: str) -> ModelPrice | None:
        return self._prices.get((provider, model))

    def estimate(
        self, provider: str, model: str, input_tokens: int | None, output_tokens: int | None
    ) -> float | None:
        """Estimated USD cost, or ``None`` when pricing or token usage is unknown."""
        price = self.lookup(provider, model)
        if price is None or (input_tokens is None and output_tokens is None):
            return None
        cost = (input_tokens or 0) * price.input_per_mtok + (
            output_tokens or 0
        ) * price.output_per_mtok
        return cost / TOKENS_PER_UNIT

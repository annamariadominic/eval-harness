from pydantic import BaseModel, ConfigDict


class ApiModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


def normalize_tags(tags: list[str]) -> list[str]:
    """Trim, lowercase, and de-duplicate tags while preserving order."""
    seen: dict[str, None] = {}
    for tag in tags:
        cleaned = "-".join(tag.strip().lower().split())
        if cleaned:
            seen.setdefault(cleaned, None)
    return list(seen)

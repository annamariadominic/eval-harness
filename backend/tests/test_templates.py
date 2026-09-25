import pytest

from app.domain.templates import TemplateError, render_template, template_variables


def test_renders_fields_and_whole_input() -> None:
    template = "Q: {{ question }}\nC: {{context}}\nFirst: {{ docs[0].title }}"
    value = {"question": "Why?", "context": "Because.", "docs": [{"title": "A"}]}
    assert render_template(template, value) == "Q: Why?\nC: Because.\nFirst: A"
    assert render_template("{{ input }}", "raw text") == "raw text"
    assert render_template("{{ input }}", {"a": 1}) == '{\n  "a": 1\n}'


def test_missing_variable_raises() -> None:
    with pytest.raises(TemplateError, match="question"):
        render_template("{{ question }}", {"context": "x"})


def test_lists_variables_once() -> None:
    assert template_variables("{{a}} {{ b.c }} {{a}}") == ["a", "b.c"]

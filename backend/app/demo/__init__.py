"""Tooling for the in-browser portfolio demo.

The demo build of the frontend runs a TypeScript port of the mock provider, evaluators, runner,
and analysis entirely in the visitor's browser. This package produces what that port needs:

* a **snapshot** of a database (every table as JSON) that seeds each visitor's sandbox;
* **golden fixtures** (real API responses and unit-level input/output pairs) that pin the
  TypeScript port to this Python implementation;
* a **recorder** that runs the example suites against real OpenAI and Anthropic models once,
  locally, so the demo can show genuine results without shipping any API key.
"""

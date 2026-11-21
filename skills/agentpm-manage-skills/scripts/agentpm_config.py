#!/usr/bin/env python
"""Persist and read the default AgentPM skills repository URL for this skill."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ENV_VAR = "AGENTPM_SKILLS_REPO_URL"
ENV_FILE_NAME = "agentpm-manage-skills.env"
LEGACY_ENV_FILE_NAME = ".agentpm-manage-skills.env"


def skill_root() -> Path:
    return Path(__file__).resolve().parent.parent


def config_dir() -> Path:
    # Machine-local settings live outside the skill folder, so `agentpm push`
    # never copies them into a shared skills repository.
    home = os.environ.get("AGENTPM_HOME")
    return Path(home) if home else Path.home() / ".agentpm"


def env_file_path() -> Path:
    return config_dir() / ENV_FILE_NAME


def legacy_env_file_path() -> Path:
    return skill_root() / LEGACY_ENV_FILE_NAME


def validate_repo_url(value: str) -> str:
    repo_url = value.strip()
    if not repo_url:
        raise ValueError("Repository URL must not be empty.")
    return repo_url


def write_env_file(repo_url: str) -> Path:
    env_file = env_file_path()
    env_file.parent.mkdir(parents=True, exist_ok=True)
    env_file.write_text(
        (
            "# Local configuration for the agentpm-manage-skills Codex skill.\n"
            f"{ENV_VAR}={repo_url}\n"
        ),
        encoding="utf-8",
    )
    return env_file


def read_env_file() -> str | None:
    # The legacy file inside the skill folder is still read, so old setups keep working.
    for env_file in (env_file_path(), legacy_env_file_path()):
        if not env_file.exists():
            continue
        for line in env_file.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if stripped.startswith(f"{ENV_VAR}="):
                return stripped.split("=", 1)[1].strip()
    return None


def resolve_repo_url() -> tuple[str | None, str | None]:
    process_value = os.environ.get(ENV_VAR)
    if process_value:
        return process_value, "process"

    file_value = read_env_file()
    if file_value:
        return file_value, "file"

    return None, None


def command_setup(args: argparse.Namespace) -> int:
    repo_url = args.repo_url
    if not repo_url:
        if not sys.stdin.isatty():
            print(
                "Missing repository URL. Re-run with --repo-url in non-interactive mode.",
                file=sys.stderr,
            )
            return 2
        repo_url = input("Default skills git repository URL: ")

    try:
        repo_url = validate_repo_url(repo_url)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    env_file = write_env_file(repo_url)
    payload = {
        "ok": True,
        "env_var": ENV_VAR,
        "repo_url": repo_url,
        "env_file": str(env_file),
    }

    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(f"Saved {ENV_VAR} to {env_file}")
        print(repo_url)
    return 0


def command_show(args: argparse.Namespace) -> int:
    repo_url, source = resolve_repo_url()
    if not repo_url:
        print(
            (
                f"{ENV_VAR} is not configured. "
                "Run `python scripts/agentpm_config.py setup` first."
            ),
            file=sys.stderr,
        )
        return 1

    if args.json:
        print(
            json.dumps(
                {
                    "ok": True,
                    "env_var": ENV_VAR,
                    "repo_url": repo_url,
                    "source": source,
                    "env_file": str(env_file_path()),
                },
                indent=2,
            )
        )
    else:
        print(repo_url)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Manage the default AgentPM skills repository URL for this skill."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    setup_parser = subparsers.add_parser(
        "setup",
        help="Prompt for or accept the default skills repository URL and save it locally.",
    )
    setup_parser.add_argument(
        "--repo-url",
        help="Default git repository URL for shared skills.",
    )
    setup_parser.add_argument(
        "--json",
        action="store_true",
        help="Emit JSON instead of human-readable output.",
    )
    setup_parser.set_defaults(func=command_setup)

    show_parser = subparsers.add_parser(
        "show",
        help="Print the resolved default skills repository URL.",
    )
    show_parser.add_argument(
        "--json",
        action="store_true",
        help="Emit JSON instead of the raw repository URL.",
    )
    show_parser.set_defaults(func=command_show)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

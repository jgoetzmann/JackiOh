#!/usr/bin/env python3
"""Interactive .env editor for JackiOh. Standard library only; no pip install.

    python3 scripts/set-env.py                  # pick a target, walk its variables
    python3 scripts/set-env.py server           # walk apps/server/.env
    python3 scripts/set-env.py web              # walk apps/web/.env
    python3 scripts/set-env.py server --key DATABASE_URL   # set just one
    python3 scripts/set-env.py server --add     # add an arbitrary KEY=value
    python3 scripts/set-env.py --check          # validate everything, change nothing

WHY THIS EXISTS. Three real failures during bring-up, all from pasting into a .env by hand:

  1. The whole line was pasted over the key, giving `DATABASE_URL=DATABASE_URL=postgresql://...`.
  2. The Postgres password held `@`, `*` and `?` unencoded. The `?` truncates the URI authority
     and the extra `@` is read as the host separator, so the URL parsed to garbage rather than
     failing loudly.
  3. The direct `db.<ref>.supabase.co` host is IPv6-only on Supabase; on an IPv4-only network it
     fails with `getaddrinfo ENOTFOUND` and the fix is the session pooler, not the connection
     string you were handed.

Every value typed here goes through `clean()` for (1), the URL-aware handlers for (2), and
DATABASE_URL gets a resolution check for (3).
"""

from __future__ import annotations

import argparse
import getpass
import os
import re
import secrets
import shutil
import socket
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable
from urllib.parse import quote, unquote

REPO = Path(__file__).resolve().parent.parent

# `env.ts`'s MIN_CODE_PEPPER_LENGTH. Stated here only to fail early with the same number.
MIN_CODE_PEPPER_LENGTH = 32


# ---------------------------------------------------------------------------------------------
# Cleaning: what a paste does to a value, undone
# ---------------------------------------------------------------------------------------------

def clean(key: str, raw: str) -> str:
    """Strip the artifacts of pasting: whitespace, wrapping quotes, and a repeated `KEY=`."""
    value = raw.strip()

    # Copying a whole line out of .env.example pastes `KEY=value` into the value slot. Repeat,
    # because pasting twice is just as easy as pasting once.
    while value.upper().startswith(f"{key.upper()}="):
        value = value[len(key) + 1 :].strip()

    # Shell habits: KEY='value' or KEY="value". dotenv would keep the quotes as data.
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]

    # A trailing comment is almost never intended as part of a secret.
    return value.strip()


def looks_percent_encoded(value: str) -> bool:
    """True when `value` is already a clean percent-encoding of something.

    Re-encoding an encoded password turns `%40` into `%2540`, which is just as broken as not
    encoding it at all. This asks the only question that distinguishes them: does decoding and
    re-encoding return exactly what we were given?
    """
    if "%" not in value:
        return False
    try:
        decoded = unquote(value, errors="strict")
    except (UnicodeDecodeError, ValueError):
        return False
    return quote(decoded, safe="") == value


def encode_userinfo(label: str, value: str, *, interactive: bool) -> str:
    """Percent-encode one userinfo field (a username or a password).

    `@`, `%`, `?`, `#`, `/`, `:` and friends all have meaning in a URI's authority. A password
    holding any of them must be escaped or the URL means something other than what you typed.
    """
    if value == "":
        return value
    if looks_percent_encoded(value):
        # Ambiguous by construction: `%40` is a valid raw password and also the encoding of `@`.
        # Only the person who owns the password knows which, so ask -- and when nobody is there
        # to ask (--check), keep it, because re-encoding is the destructive reading.
        if not interactive:
            return value
        if ask_yes_no(f"  The {label} already looks percent-encoded. Keep it as-is?", default=True):
            return value
    encoded = quote(value, safe="")
    if encoded != value:
        changed = sorted({c for c in value if quote(c, safe="") != c})
        print(f"  encoded {len(changed)} special character(s) in the {label}: {' '.join(changed)}")
    return encoded


# ---------------------------------------------------------------------------------------------
# DATABASE_URL: the one value with real structure
# ---------------------------------------------------------------------------------------------

POSTGRES_RE = re.compile(r"^(?P<scheme>postgres(?:ql)?)://(?P<rest>.+)$", re.IGNORECASE)


def handle_database_url(value: str, *, interactive: bool) -> str:
    """Rebuild a Postgres URL with its userinfo correctly escaped."""
    m = POSTGRES_RE.match(value)
    if not m:
        raise Problem(
            "must start with postgresql:// or postgres:// "
            "(Supabase dashboard -> Project Settings -> Database -> Connection string -> URI)"
        )

    rest = m.group("rest")
    # The LAST '@' is the separator: a host never contains one, a password often does. Splitting
    # on the first '@' is exactly the bug that made a pasted password parse as a hostname.
    userinfo, sep, hostpart = rest.rpartition("@")
    if not sep:
        raise Problem("no '@' between the credentials and the host")
    user, _, password = userinfo.partition(":")

    user = encode_userinfo("username", user, interactive=interactive)
    password = encode_userinfo("password", password, interactive=interactive)

    if "/" not in hostpart:
        raise Problem("no database name after the host (expected .../postgres)")

    rebuilt = f"{m.group('scheme').lower()}://{user}:{password}@{hostpart}"
    if interactive:
        warn_about_ipv6_only_host(hostpart)
    return rebuilt


def warn_about_ipv6_only_host(hostpart: str) -> None:
    """Supabase's direct DB host has no A record; an IPv4-only machine cannot reach it."""
    host = hostpart.split("/")[0].split(":")[0]
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        print(f"  ! {host} does not resolve at all from here.")
        _suggest_pooler(host)
        return

    families = {info[0] for info in infos}
    if socket.AF_INET not in families and socket.AF_INET6 in families:
        print(f"  ! {host} is IPv6-only (no A record).")
        if not _has_global_ipv6():
            print("    This machine has no global IPv6 address, so this host is unreachable.")
            _suggest_pooler(host)


def _has_global_ipv6() -> bool:
    try:
        sock = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
        try:
            # No packet is sent; this only picks a source address, and fails without a route.
            sock.connect(("2001:4860:4860::8888", 53))
            return True
        finally:
            sock.close()
    except OSError:
        return False


def _suggest_pooler(host: str) -> None:
    ref = host.split(".")[1] if host.startswith("db.") and host.count(".") >= 2 else "<ref>"
    print("    Use the SESSION pooler instead (Dashboard -> Connect -> Session pooler):")
    print(f"      postgresql://postgres.{ref}:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres")
    print("    Port 5432, NOT the 6543 transaction pooler: db:migrate holds a pg_advisory_lock")
    print("    across statements, which transaction mode drops.")


# ---------------------------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------------------------

class Problem(Exception):
    """A value that cannot be written as given. The message says what to do about it."""


def require_https(value: str) -> str:
    if not value.startswith("https://"):
        raise Problem("must be an https:// URL, e.g. https://<ref>.supabase.co")
    return value.rstrip("/")


def require_secret_key(value: str) -> str:
    if value.startswith("sb_publishable_"):
        raise Problem("that is the PUBLISHABLE key. The secret key starts with sb_secret_")
    if not (value.startswith("sb_secret_") or value.count(".") == 2):
        raise Problem("expected sb_secret_... (or a legacy service_role JWT)")
    return value


def require_publishable_key(value: str) -> str:
    # The important half of this check. A VITE_ variable is compiled into the browser bundle;
    # a secret key there is published to every visitor and bypasses every RLS policy.
    if value.startswith("sb_secret_"):
        raise Problem(
            "REFUSING: that is the SECRET key, and this variable ships to the browser. "
            "Use the publishable key (sb_publishable_...)"
        )
    if not (value.startswith("sb_publishable_") or value.count(".") == 2):
        raise Problem("expected sb_publishable_... (or a legacy anon JWT)")
    return value


def require_pepper(value: str) -> str:
    if len(value) < MIN_CODE_PEPPER_LENGTH:
        raise Problem(
            f"must be at least {MIN_CODE_PEPPER_LENGTH} characters "
            f"(got {len(value)}); the server refuses to boot otherwise"
        )
    return value


def require_origins(value: str) -> str:
    parts = [p.strip() for p in value.split(",") if p.strip()]
    if not parts:
        raise Problem("expected one or more comma-separated origins, e.g. http://localhost:5173")
    for part in parts:
        if not part.startswith(("http://", "https://")):
            raise Problem(f"{part!r} is not an origin (needs a scheme)")
        if part.rstrip("/") != part:
            raise Problem(f"{part!r} must not end in a slash: an Origin header never does")
    return ",".join(parts)


def require_nonempty(value: str) -> str:
    if not value:
        raise Problem("must not be empty")
    return value


# ---------------------------------------------------------------------------------------------
# The variables, per target
# ---------------------------------------------------------------------------------------------

@dataclass
class Var:
    key: str
    prompt: str
    secret: bool = False
    validate: Callable[[str], str] | None = None
    handler: Callable[..., str] | None = None
    generator: Callable[[], str] | None = None
    note: str = ""


@dataclass
class Target:
    name: str
    path: Path
    variables: list[Var] = field(default_factory=list)


TARGETS: dict[str, Target] = {
    "server": Target(
        name="server",
        path=REPO / "apps" / "server" / ".env",
        variables=[
            Var("SUPABASE_URL", "Project URL (Settings -> Data API)", validate=require_https),
            Var(
                "SUPABASE_SECRET_KEY",
                "Secret key, sb_secret_... (Settings -> API Keys)",
                secret=True,
                validate=require_secret_key,
            ),
            Var(
                "DATABASE_URL",
                "Postgres connection string (Settings -> Database)",
                secret=True,
                handler=handle_database_url,
                note="paste it with the real password; special characters get encoded here",
            ),
            Var(
                "CODE_PEPPER",
                f"Invite-code HMAC pepper, >= {MIN_CODE_PEPPER_LENGTH} chars",
                secret=True,
                validate=require_pepper,
                generator=lambda: secrets.token_urlsafe(48),
            ),
            Var("CATALOG_VERSION", "Catalog version", validate=require_nonempty),
            Var("PUBLIC_ORIGINS", "Allowed browser origins", validate=require_origins),
        ],
    ),
    "web": Target(
        name="web",
        path=REPO / "apps" / "web" / ".env",
        variables=[
            Var("VITE_SUPABASE_URL", "Project URL (same as the server's)", validate=require_https),
            Var(
                "VITE_SUPABASE_PUBLISHABLE_KEY",
                "Publishable key, sb_publishable_... (Settings -> API Keys)",
                validate=require_publishable_key,
                note="this ships to the browser: never the secret key",
            ),
        ],
    ),
}


# ---------------------------------------------------------------------------------------------
# Reading and writing the file, without losing its comments
# ---------------------------------------------------------------------------------------------

def read_values(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value
    return values


def write_values(path: Path, updates: dict[str, str]) -> None:
    """Replace each key in place, keeping every comment and the file's order. Append the rest."""
    if not updates:
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    lines = path.read_text().splitlines(keepends=True) if path.exists() else []

    if path.exists():
        backup = path.with_suffix(path.suffix + ".bak")
        shutil.copy2(path, backup)
        print(f"\nbacked up {rel(path)} -> {rel(backup)}")

    if not lines:
        # A brand-new file gets a header rather than starting with a bare blank line.
        lines = [
            f"# {rel(path)} -- written by scripts/set-env.py. Gitignored; never commit it.\n",
            "# Re-run `python3 scripts/set-env.py` to change a value.\n",
        ]

    remaining = dict(updates)
    for i, line in enumerate(lines):
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        key = line.partition("=")[0].strip()
        if key in remaining:
            nl = "\n" if line.endswith("\n") else ""
            lines[i] = f"{key}={remaining.pop(key)}{nl}"

    if remaining:
        if lines and not lines[-1].endswith("\n"):
            lines.append("\n")
        lines.append("\n# Added by scripts/set-env.py\n")
        for key, value in remaining.items():
            lines.append(f"{key}={value}\n")

    path.write_text("".join(lines))
    # These files hold a key that bypasses every RLS policy. Owner-only, always.
    os.chmod(path, 0o600)
    print(f"wrote {rel(path)} ({len(updates)} variable(s)), mode 600")


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(REPO))
    except ValueError:
        return str(path)


# ---------------------------------------------------------------------------------------------
# Display: never print a secret back
# ---------------------------------------------------------------------------------------------

def mask(key: str, value: str) -> str:
    if not value:
        return "(empty)"
    if "REPLACE_ME" in value or "YOUR_PROJECT_REF" in value:
        return "(placeholder)"
    if key == "DATABASE_URL":
        m = POSTGRES_RE.match(value)
        if m:
            userinfo, sep, hostpart = m.group("rest").rpartition("@")
            if sep:
                user = userinfo.partition(":")[0]
                return f"{m.group('scheme')}://{user}:***@{hostpart}"
        return "(unparseable)"
    if is_secretish(key):
        head = value[:10]
        return f"{head}... ({len(value)} chars)"
    return value


def is_secretish(key: str) -> bool:
    return any(word in key.upper() for word in ("KEY", "SECRET", "PEPPER", "PASSWORD", "TOKEN"))


# ---------------------------------------------------------------------------------------------
# Prompting
# ---------------------------------------------------------------------------------------------

def ask_yes_no(question: str, *, default: bool) -> bool:
    suffix = "[Y/n]" if default else "[y/N]"
    while True:
        answer = input(f"{question} {suffix} ").strip().lower()
        if not answer:
            return default
        if answer in ("y", "yes"):
            return True
        if answer in ("n", "no"):
            return False


def read_value(var: Var, current: str | None) -> str | None:
    """Prompt for one variable. Returns None when the user keeps what is already there."""
    print(f"\n{var.key}")
    print(f"  {var.prompt}")
    if var.note:
        print(f"  note: {var.note}")
    if current is not None:
        print(f"  current: {mask(var.key, current)}")
    if var.generator is not None:
        print("  (type 'gen' to generate one)")

    hint = "Enter to keep" if current else "required"
    if var.secret:
        # Read secrets with getpass so they never reach the terminal scrollback, which outlives
        # the session and tends to end up in screen shares. Pasting still works; you just do not
        # see it. Everything else is echoed, because seeing a URL you mistyped is worth more.
        print("  (input hidden)")
    while True:
        entry = (getpass.getpass(f"  value [{hint}]: ") if var.secret
                 else input(f"  value [{hint}]: "))
        raw = entry.strip()

        if not raw:
            if current:
                return None
            print("  ! required")
            continue

        if raw == "gen" and var.generator is not None:
            value = var.generator()
            print(f"  generated {len(value)} characters")
        else:
            value = clean(var.key, entry)

        try:
            if var.handler is not None:
                value = var.handler(value, interactive=True)
            if var.validate is not None:
                value = var.validate(value)
        except Problem as problem:
            print(f"  ! {var.key}: {problem}")
            continue

        return value


# ---------------------------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------------------------

def walk(target: Target, only: str | None) -> None:
    current = read_values(target.path)
    variables = target.variables
    if only is not None:
        variables = [v for v in variables if v.key.upper() == only.upper()]
        if not variables:
            known = ", ".join(v.key for v in target.variables)
            print(f"{only} is not a {target.name} variable. Known: {known}")
            print(f"Use --add to set it anyway.")
            raise SystemExit(1)

    print(f"\nTarget: {rel(target.path)}")
    print("Enter keeps the current value. Ctrl-C aborts without writing.")

    updates: dict[str, str] = {}
    for var in variables:
        existing = current.get(var.key)
        if existing is not None and ("REPLACE_ME" in existing or "YOUR_PROJECT_REF" in existing):
            existing = None
        value = read_value(var, existing)
        if value is not None:
            updates[var.key] = value

    if not updates:
        print("\nNothing changed.")
        return
    write_values(target.path, updates)


def add_one(target: Target) -> None:
    print(f"\nTarget: {rel(target.path)}")
    key = input("KEY: ").strip().upper()
    if not key or not re.fullmatch(r"[A-Z_][A-Z0-9_]*", key):
        print("! a variable name is A-Z, 0-9 and underscores, not starting with a digit")
        raise SystemExit(1)

    if target.name == "web" and not key.startswith("VITE_"):
        print(f"! {key} would not reach the browser: Vite only exposes VITE_-prefixed variables.")
        if not ask_yes_no("  Add it anyway?", default=False):
            return
    if target.name == "web" and is_secretish(key):
        print(f"! {key} looks like a secret, and every VITE_ variable is compiled into the")
        print("  browser bundle where anyone can read it.")
        if not ask_yes_no("  Add it anyway?", default=False):
            return

    var = Var(key, "free-form value", secret=is_secretish(key))
    # An arbitrary key still gets the paste-artifact cleanup and, if it looks like a Postgres
    # URL, the same userinfo encoding: those are the bugs this script exists to prevent.
    if key.endswith("_URL") or key == "DATABASE_URL":
        var.handler = lambda v, interactive: (
            handle_database_url(v, interactive=interactive) if POSTGRES_RE.match(v) else v
        )

    value = read_value(var, read_values(target.path).get(key))
    if value is None:
        print("\nNothing changed.")
        return
    write_values(target.path, {key: value})


def check() -> int:
    problems = 0
    for target in TARGETS.values():
        print(f"\n{rel(target.path)}")
        if not target.path.exists():
            print("  (does not exist)")
            problems += 1
            continue
        values = read_values(target.path)
        for var in target.variables:
            value = values.get(var.key)
            if value is None:
                print(f"  {var.key:<32} MISSING")
                problems += 1
                continue
            try:
                candidate = clean(var.key, value)
                if var.handler is not None:
                    candidate = var.handler(candidate, interactive=False)
                if var.validate is not None:
                    var.validate(candidate)
            except Problem as problem:
                print(f"  {var.key:<32} {mask(var.key, value)}  <- {problem}")
                problems += 1
                continue
            drifted = " (needs re-encoding)" if candidate != value else ""
            print(f"  {var.key:<32} {mask(var.key, value)}{drifted}")
            if drifted:
                problems += 1
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description="Fill in JackiOh's .env files safely.")
    parser.add_argument("target", nargs="?", choices=sorted(TARGETS), help="which .env to edit")
    parser.add_argument("--key", help="set only this variable")
    parser.add_argument("--add", action="store_true", help="add an arbitrary KEY=value")
    parser.add_argument("--check", action="store_true", help="validate, change nothing")
    args = parser.parse_args()

    if args.check:
        problems = check()
        print(f"\n{problems} problem(s).")
        return 1 if problems else 0

    name = args.target
    if name is None:
        print("Which .env?")
        for i, key in enumerate(sorted(TARGETS), start=1):
            print(f"  {i}. {key:<8} {rel(TARGETS[key].path)}")
        choice = input("choice: ").strip()
        names = sorted(TARGETS)
        if choice.isdigit() and 1 <= int(choice) <= len(names):
            name = names[int(choice) - 1]
        elif choice in TARGETS:
            name = choice
        else:
            print("! no such target")
            return 1

    target = TARGETS[name]
    if args.add:
        add_one(target)
    else:
        walk(target, args.key)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\naborted; nothing written")
        raise SystemExit(130)

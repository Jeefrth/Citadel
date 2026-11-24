"""Extra vars hardening for playbook jobs (operator -> controller RCE / credential theft)."""

import os
import shutil
import subprocess
from types import SimpleNamespace

import pytest

from app.services.jobs import render_vars_file, validate_extra_vars

PB = SimpleNamespace(variables={"who": "défaut", "packages": ["curl"]})


@pytest.mark.parametrize("extra", [
    {"ansible_connection": "local"},
    {"ansible_host": "attacker.example"},
    {"ANSIBLE_SSH_COMMON_ARGS": "-o ProxyCommand=sh"},
    {"hostvars": {}},
    {"become": True},
])
def test_ansible_and_reserved_variables_are_refused_even_for_admins(extra):
    with pytest.raises(ValueError):
        validate_extra_vars(extra, PB, is_admin=True)


@pytest.mark.parametrize("value", [
    "{{ lookup('pipe', 'id') }}", "x {% if 1 %}", "{# c #}", ["ok", "{{ 7*7 }}"], {"k": "{{ x }}"},
])
def test_templating_is_refused(value):
    with pytest.raises(ValueError):
        validate_extra_vars({"who": value}, PB, is_admin=True)


def test_operators_only_override_declared_variables():
    assert validate_extra_vars({"who": "Op"}, PB, is_admin=False) == {"who": "Op"}
    with pytest.raises(ValueError, match="pas déclarée"):
        validate_extra_vars({"target_dir": "/tmp"}, PB, is_admin=False)
    assert validate_extra_vars({"target_dir": "/tmp"}, PB, is_admin=True)


def test_invalid_names_and_types():
    for bad in ({"1abc": 1}, {"a-b": 1}, {"_x": 1}, {"ok": object()}):
        with pytest.raises(ValueError):
            validate_extra_vars(bad, PB, is_admin=True)


@pytest.mark.skipif(shutil.which("ansible-playbook") is None, reason="ansible-playbook not installed")
def test_runtime_values_are_never_templated_by_ansible(tmp_path):
    """Real ansible-playbook run on the generated vars file: admin defaults are
    templated, run-time values stay literal (even if validation were bypassed)."""
    (tmp_path / "pb.yml").write_text(
        "- hosts: localhost\n  gather_facts: false\n  tasks:\n"
        "    - ansible.builtin.debug: msg=\"d=[{{ default_t }}] r=[{{ runtime }}]\"\n")
    (tmp_path / "vars.yml").write_text(render_vars_file({"default_t": "{{ 6*7 }}"}, {"runtime": "{{ 7*7 }}"}))
    out = subprocess.run(
        ["ansible-playbook", "-i", "localhost,", "-c", "local", "pb.yml", "-e", "@vars.yml"],
        cwd=tmp_path, capture_output=True, text=True, timeout=120,
        env={"PATH": os.environ["PATH"], "HOME": str(tmp_path), "ANSIBLE_NOCOLOR": "1"},
    ).stdout
    assert "d=[42] r=[{{ 7*7 }}]" in out, out

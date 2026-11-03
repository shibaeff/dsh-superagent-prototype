"""Installer regressions. Run with: python3 tests/tui-session-delete.py."""
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

loader = importlib.machinery.SourceFileLoader(
    'tui_patch', str(Path(__file__).resolve().parents[1] / 'scripts/dsh-tui-session-delete'))
spec = importlib.util.spec_from_loader(loader.name, loader)
patch = importlib.util.module_from_spec(spec)
loader.exec_module(patch)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='TUI package with spaces ')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / 'package.json').write_text(json.dumps({
            'name': '@deepseek-harness-tui/dsh-tui', 'version': patch.VERSION}))
        self.originals = {}
        for relative, edits in patch.PATCHES.items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            self.originals[relative] = '\n'.join(before for before, _ in edits)
            path.write_text(self.originals[relative])

    def contents(self):
        return {relative: (self.root / relative).read_text() for relative in patch.PATCHES}

    def test_install_is_repeatable_and_restore_is_exact(self):
        patch.run(self.root)
        installed = self.contents()
        self.assertNotEqual(installed, self.originals)
        patch.run(self.root)
        self.assertEqual(self.contents(), installed)
        patch.run(self.root, restore=True)
        self.assertEqual(self.contents(), self.originals)
        self.assertFalse((self.root / patch.BACKUP).exists())

    def test_unrecognized_last_file_leaves_every_file_untouched(self):
        last = self.root / list(patch.PATCHES)[-1]
        last.write_text('unrecognized build')
        before = self.contents()
        with self.assertRaises(ValueError):
            patch.run(self.root)
        self.assertEqual(self.contents(), before)
        self.assertFalse((self.root / patch.BACKUP).exists())

    def test_restore_refuses_to_overwrite_a_subsequent_update(self):
        patch.run(self.root)
        path = self.root / next(iter(patch.PATCHES))
        path.write_text('new upstream version')
        before = self.contents()
        with self.assertRaises(ValueError):
            patch.run(self.root, restore=True)
        self.assertEqual(self.contents(), before)

    def test_upgrade_extends_the_original_backup(self):
        previous = dict(list(self.originals.items())[:-1])
        (self.root / patch.BACKUP).write_text(json.dumps({
            relative: {'original': original} for relative, original in previous.items()}))
        for relative, original in previous.items():
            (self.root / relative).write_text(patch.patched(relative, original))
        patch.run(self.root)
        patch.run(self.root, restore=True)
        self.assertEqual(self.contents(), self.originals)

    def test_interrupted_install_can_be_completed_or_restored(self):
        for restore in (False, True):
            with self.subTest(restore=restore):
                for relative, original in self.originals.items():
                    (self.root / relative).write_text(original)
                saved = {relative: {'original': original} for relative, original in self.originals.items()}
                (self.root / patch.BACKUP).write_text(json.dumps(saved))
                relative = next(iter(patch.PATCHES))
                (self.root / relative).write_text(patch.patched(relative, self.originals[relative]))
                patch.run(self.root, restore=restore)
                if restore:
                    self.assertEqual(self.contents(), self.originals)
                else:
                    self.assertNotEqual(self.contents(), self.originals)


if __name__ == '__main__':
    unittest.main()

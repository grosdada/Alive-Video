"""Contrat du sélecteur Mac : arguments sûrs, annulation, erreurs et racine."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.videoexport import pick_folder


class FolderPickerTests(unittest.TestCase):
    @patch("sys.platform", "darwin")
    @patch("subprocess.run")
    def test_unicode_path_passed_as_argument_and_dialog_activated(self, run):
        with tempfile.TemporaryDirectory(prefix='Vidéos de Noël "test" ') as folder:
            run.return_value = subprocess.CompletedProcess([], 0, folder + "/\n", "")
            self.assertEqual(pick_folder(folder), folder)
            args = run.call_args.args[0]
            self.assertEqual(args[-1], str(Path(folder).resolve()))
            self.assertNotIn(folder, args[2])
            self.assertIn("activate", args[2])
            self.assertIn("on error number -128", args[2])

    @patch("sys.platform", "darwin")
    @patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, "\n", ""))
    def test_cancel(self, _):
        self.assertEqual(pick_folder(), "")

    @patch("sys.platform", "darwin")
    @patch("subprocess.run", return_value=subprocess.CompletedProcess([], 1, "", "dialogue indisponible"))
    def test_failure_is_visible(self, _):
        with self.assertRaisesRegex(RuntimeError, "dialogue indisponible"):
            pick_folder()

    @patch("sys.platform", "darwin")
    @patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, "/\n", ""))
    def test_root_not_treated_as_cancel(self, _):
        self.assertEqual(pick_folder(), "/")


if __name__ == "__main__":
    unittest.main()

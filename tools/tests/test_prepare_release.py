import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import prepare_release as release


class ReleasePreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.patch_root = patch.object(release, 'ROOT', self.root)
        self.patch_root.start()
        self.addCleanup(self.patch_root.stop)
        for name in ('LICENSE', 'NOTICE', 'CHANGELOG.md'):
            (self.root / name).write_text('fixture\n')
        (self.root / 'patches-list.json').write_text(json.dumps({'version': '0.0.1', 'patches': [{'name': 'Cadence'}]}))
        self.mpp = self.root / 'input.mpp'
        self.out = self.root / 'staged'

    def bundle(self, *, smoke=False, dex=True, info=True, notices=True, notice_text='fixture attribution', version='0.0.1'):
        with zipfile.ZipFile(self.mpp, 'w') as archive:
            archive.writestr('META-INF/MANIFEST.MF', f'Name: Cadence\r\nVersion: {version}\r\n')
            archive.writestr('cadence/runtime.js', 'var Cadence = true;')
            if notices:
                archive.writestr('cadence/legal/license.txt', 'fixture license')
                archive.writestr('cadence/legal/notice.txt', notice_text)
            if dex:
                archive.writestr('classes.dex', b'dex\n035\0fixture')
            if info:
                archive.writestr('cadence/build-info.json', json.dumps({'schema': 1, 'hbcVersion': 98, 'uiSmoke': smoke}))

    def stage(self, **kwargs):
        return release.stage(self.mpp, self.out, kwargs.pop('version', '0.0.1'), kwargs.pop('repository', 'uta-a/cadence'),
                             'Unreleased test notes', created_at='2026-11-11T00:00:00', **kwargs)

    def test_normal_bundle_stages_metadata_and_checksums_without_signing_claim(self):
        self.bundle()
        metadata = self.stage()
        self.assertEqual(metadata['version'], '0.0.1')
        self.assertEqual(metadata['public_key'], '')
        self.assertEqual(metadata['signature_download_url'], '')
        self.assertEqual(metadata['download_url'], 'https://github.com/uta-a/cadence/releases/download/v0.0.1/patches-0.0.1.mpp')
        self.assertEqual(self.mpp.read_bytes(), (self.out / 'patches-0.0.1.mpp').read_bytes())
        for line in (self.out / 'SHA256SUMS').read_text().splitlines():
            digest, name = line.split('  ')
            self.assertEqual(hashlib.sha256((self.out / name).read_bytes()).hexdigest(), digest)
        self.assertEqual(len(list(self.out.iterdir())), 7)

    def test_smoke_or_missing_entries_never_produce_output(self):
        for options in ({'smoke': True}, {'dex': False}, {'info': False}, {'notices': False}, {'version': '0.0.2'}):
            with self.subTest(options=options):
                self.bundle(**options)
                with self.assertRaises(ValueError):
                    self.stage()
                self.assertFalse(self.out.exists())

    def test_empty_attribution_is_rejected(self):
        self.bundle(notice_text='')
        with self.assertRaisesRegex(ValueError, 'Empty license or attribution'):
            self.stage()
        self.assertFalse(self.out.exists())

    def test_invalid_version_repository_or_stale_output_are_rejected(self):
        self.bundle()
        for options in ({'version': '../bad'}, {'version': '01.0.0'}, {'repository': '../cadence'}, {'repository': 'https://github.com/uta-a/cadence'}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.stage(**options)
        self.stage()
        with self.assertRaises(ValueError):
            self.stage()

    def test_patch_list_version_must_match_mpp(self):
        self.bundle()
        (self.root / 'patches-list.json').write_text(json.dumps({'version': '1.0.0', 'patches': [{}]}))
        with self.assertRaisesRegex(ValueError, 'patch-list'):
            self.stage()
        self.assertFalse(self.out.exists())


if __name__ == '__main__':
    unittest.main()

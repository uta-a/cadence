"""Static catalog consistency checks. These never execute a Metro factory or validate runtime shapes."""
import hashlib
import json
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
from hbc import HbcFile


def catalog():
    return json.loads((ROOT / 'runtime/modules/352.17.json').read_text())


class CatalogTests(unittest.TestCase):
    def test_catalog_distinguishes_identity_checks_from_feature_approval(self):
        data = catalog()
        self.assertIs(data['_meta']['runtimeChecked'], True)
        entries = [v for k, v in data.items() if not k.startswith('_')]
        self.assertGreaterEqual(len(entries), 14)
        ids = []
        for entry in entries:
            self.assertIs(entry['verified'], False)
            self.assertIsInstance(entry['id'], int)
            self.assertTrue(0 <= entry['id'] <= 32767)
            self.assertTrue(entry['evidence'])
            self.assertTrue(entry['shape'])
            self.assertTrue(all(isinstance(path, str) and all(path.split('.')) for path in entry['shape']))
            ids.append(entry['id'])
        self.assertEqual(len(ids), len(set(ids)))

    def test_observation_receipt_contains_only_allowlisted_module_metadata(self):
        data = catalog()
        receipt = json.loads((ROOT / 'runtime/modules/352.17-observed.json').read_text())
        self.assertEqual({'_meta', 'modules', 'notObserved'}, set(receipt))
        self.assertEqual(data['_meta']['bundleSha256'], receipt['_meta']['sourceBundleSha256'])
        for flag in ['probeAccessorsEvaluated', 'storeMethodsCalled', 'messagesSent', 'featureHooksEnabled', 'normalSmokeFlag']:
            self.assertIs(receipt['_meta'][flag], False)
        self.assertIs(receipt['_meta']['nativeSettingsWrites'], True)
        self.assertIs(receipt['_meta']['coreUiHookEnabled'], True)
        self.assertEqual([7522], receipt['_meta']['importsAfterNavigationReady'])
        kinds = {'undefined', 'boolean', 'number', 'string', 'symbol', 'bigint', 'function',
                 'object', 'null', 'accessor', 'missing', 'uninspectable', 'depth-limit'}
        for name, observed in receipt['modules'].items():
            self.assertEqual({'id', 'started', 'completed', 'paths'}, set(observed))
            self.assertEqual(data[name]['id'], observed['id'])
            self.assertEqual(data[name]['shape'], list(observed['paths']))
            self.assertTrue(all(kind in kinds for kind in observed['paths'].values()))
            self.assertGreater(observed['completed'], observed['started'])
        names = {key for key in data if not key.startswith('_')}
        self.assertEqual(names, set(receipt['modules']) | set(receipt['notObserved']))
        self.assertFalse(set(receipt['modules']) & set(receipt['notObserved']))


@unittest.skipUnless(os.environ.get('DISK_BUNDLE'), 'set DISK_BUNDLE to check catalog evidence against original HBC')
class CatalogBundleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = catalog()
        cls.hbc = HbcFile(os.environ['DISK_BUNDLE'])
        cls.entries = {k: v for k, v in cls.data.items() if not k.startswith('_')}

    def test_input_and_module_registrations(self):
        self.assertEqual(self.data['_meta']['bundleSha256'], hashlib.sha256(self.hbc.data).hexdigest())
        modules = self.hbc.modules()
        for name, entry in self.entries.items():
            with self.subTest(module=name):
                self.assertEqual(entry['factory'], modules[entry['id']]['factory'])
                for evidence in entry['evidence']:
                    if evidence['kind'] == 'registration':
                        self.assertEqual(0, evidence['function'])
                        self.assertEqual(evidence['offset'], modules[entry['id']]['offset'])

    def test_evidence_points_to_instruction_boundaries(self):
        offsets = {}
        for name, entry in self.entries.items():
            for evidence in entry['evidence']:
                function = evidence['function']
                if function not in offsets:
                    offsets[function] = {instruction.offset for instruction in self.hbc.instructions(function)}
                with self.subTest(module=name, function=function, offset=evidence['offset']):
                    self.assertIn(evidence['offset'], offsets[function])


if __name__ == '__main__':
    unittest.main()

import re, unittest
from pathlib import Path
ROOT = Path(__file__).parent
class FirstBootTests(unittest.TestCase):
    def test_firstboot_is_idempotent_and_waits_for_network(self):
        text=(ROOT/'nurseaid-firstboot').read_text()
        self.assertIn('grep -qx complete', text)
        self.assertIn('network', (ROOT/'nurseaid-firstboot.service').read_text())
        self.assertIn('CENTRAL_URL/health', text)
        self.assertIn('docker compose config --quiet', text)
        self.assertIn('docker compose up -d --build', text)
        self.assertIn('ssh-keygen -A', text)
        self.assertIn('hostnamectl set-hostname', text)
    def test_secrets_are_random_and_private(self):
        text=(ROOT/'nurseaid-firstboot').read_text()
        self.assertGreaterEqual(text.count('openssl rand'), 5)
        self.assertIn('chmod 0600 "$PROJECT_DIR/.env"', text)
        self.assertNotIn('NewSoftTech', text)
    def test_golden_cleanup_requires_marker_and_execute_flag(self):
        text=(ROOT/'prepare-golden-image').read_text()
        self.assertIn('--execute', text)
        self.assertIn('/etc/nurseaid-golden-image-builder', text)
        self.assertIn('docker compose down --volumes', text)
        self.assertIn('truncate -s 0 /etc/machine-id', text)
if __name__ == '__main__': unittest.main()

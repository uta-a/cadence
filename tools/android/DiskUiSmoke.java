package app.disk.test;

import com.android.uiautomator.core.UiObject;
import com.android.uiautomator.core.UiSelector;
import com.android.uiautomator.testrunner.UiAutomatorTestCase;

/** Test only disk-owned controls. Never dump account/chat UI or take screenshots. */
public class DiskUiSmoke extends UiAutomatorTestCase {
    private UiObject control(String label) {
        return new UiObject(new UiSelector().packageName("com.discord").description(label).enabled(true));
    }
    public void testNamedAction() throws Exception {
        String action = getParams().getString("action", "open-disk");
        if (action.equals("open-disk")) {
            UiObject entry = control("disk");
            assertTrue("DISK_UI disk entry missing", entry.waitForExists(15000));
            entry.click();
            assertTrue("DISK_UI page missing", new UiObject(new UiSelector().packageName("com.discord").text("disk 設定")).waitForExists(5000));
            System.out.println("DISK_UI disk page visible");
        } else if (action.equals("toggle-compact")) {
            UiObject toggle = control("disk:compact");
            assertTrue("DISK_UI compact control missing", toggle.waitForExists(5000));
            toggle.click();
            getUiDevice().waitForIdle();
            System.out.println("DISK_UI compact toggled");
        } else if (action.equals("show-logs")) {
            assertTrue("DISK_UI feature info missing", control("disk:features").waitForExists(5000));
            assertEquals("組み込み機能: なし", control("disk:features").getText());
            UiObject logs = control("disk:logs");
            assertTrue("DISK_UI log toggle missing", logs.exists());
            logs.click();
            assertTrue("DISK_UI memory logs missing", control("disk:log-content").waitForExists(5000));
            System.out.println("DISK_UI memory logs and empty build manifest visible");
        } else if (action.equals("check-saved")) {
            assertTrue("DISK_UI save acknowledgement missing", control("disk:saved").waitForExists(10000));
            System.out.println("DISK_UI native save and read-back acknowledged");
        } else if (action.equals("close-disk")) {
            assertTrue("DISK_UI disk page missing", new UiObject(new UiSelector().packageName("com.discord").text("disk 設定")).exists());
            getUiDevice().pressBack();
            getUiDevice().waitForIdle();
            assertTrue("DISK_UI overview entry missing after back", control("disk").waitForExists(5000));
            System.out.println("DISK_UI hardware back preserved overview");
        } else if (action.equals("toggle-feature") || action.equals("check-feature")) {
            String feature = getParams().getString("feature", "");
            boolean extra = feature.equals("quickDelete") || feature.equals("noConfirmPin") || feature.equals("alwaysTrust");
            assertTrue("DISK_UI invalid feature", extra || feature.equals("fakeNitro") || feature.equals("platformIndicator"));
            String prefix = extra ? "disk:extra:" : "disk:feature:";
            if (action.equals("toggle-feature")) {
                UiObject toggle = control(prefix + feature);
                assertTrue("DISK_UI feature control missing", toggle.waitForExists(5000));
                toggle.click();
                getUiDevice().waitForIdle();
                System.out.println("DISK_UI feature toggled");
            } else {
                String expected = getParams().getString("expected", "false");
                assertTrue("DISK_UI invalid expected value", expected.equals("true") || expected.equals("false"));
                assertTrue("DISK_UI feature state mismatch", control(prefix + feature + ":" + expected).waitForExists(5000));
                System.out.println("DISK_UI feature matches expected");
            }
        } else if (action.equals("check-compact")) {
            String expected = getParams().getString("expected", "false");
            assertTrue("DISK_UI invalid expected value", expected.equals("true") || expected.equals("false"));
            assertTrue("DISK_UI persisted compact state mismatch", control("disk:compact:" + expected).waitForExists(5000));
            System.out.println("DISK_UI compact matches expected");
        } else {
            fail("DISK_UI unsupported action");
        }
    }
}

package app.disk.test;

import android.graphics.Rect;
import com.android.uiautomator.core.UiObject;
import com.android.uiautomator.core.UiScrollable;
import com.android.uiautomator.core.UiSelector;
import com.android.uiautomator.testrunner.UiAutomatorTestCase;

/** Test only disk-owned controls. Never dump account/chat UI or take screenshots. */
public class DiskUiSmoke extends UiAutomatorTestCase {
    private UiObject control(String label) {
        return new UiObject(new UiSelector().packageName("com.discord").description(label).enabled(true));
    }
    /** The disk page grows with each feature; scroll the named control into view before using it. */
    private UiObject scrolled(String label) throws Exception {
        return scrolled(new UiSelector().packageName("com.discord").description(label));
    }
    private UiObject scrolled(UiSelector selector) throws Exception {
        UiScrollable page = new UiScrollable(new UiSelector().packageName("com.discord").scrollable(true));
        if (page.exists() && !new UiObject(selector).exists()) {
            page.scrollToBeginning(10);
            page.scrollIntoView(selector);
        } else if (page.exists()) {
            page.scrollIntoView(selector);
        }
        getUiDevice().waitForIdle();
        UiObject target = new UiObject(selector.enabled(true));
        if (page.exists() && target.exists()) {
            Rect viewport = page.getVisibleBounds();
            Rect bounds = target.getBounds();
            int delta = bounds.centerY() - viewport.centerY();
            if (Math.abs(delta) > viewport.height() / 4) {
                int end = Math.max(viewport.top + 80, Math.min(viewport.bottom - 80, viewport.centerY() - delta));
                getUiDevice().swipe(viewport.centerX(), viewport.centerY(), viewport.centerX(), end, 20);
                getUiDevice().waitForIdle();
            }
        }
        return target;
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
            assertTrue("DISK_UI save acknowledgement missing", scrolled("disk:saved").waitForExists(10000));
            System.out.println("DISK_UI native save and read-back acknowledged");
        } else if (action.equals("close-disk")) {
            assertTrue("DISK_UI disk page missing", new UiObject(new UiSelector().packageName("com.discord").text("disk 設定")).exists());
            getUiDevice().pressBack();
            getUiDevice().waitForIdle();
            assertTrue("DISK_UI overview entry missing after back", control("disk").waitForExists(5000));
            System.out.println("DISK_UI hardware back preserved overview");
        } else if (action.equals("open-history")) {
            UiObject entry = scrolled("disk:history:open");
            assertTrue("DISK_UI history entry missing", entry.waitForExists(5000)); entry.click();
            assertTrue("DISK_UI history panel missing", control("disk:history:count").waitForExists(5000));
            System.out.println("DISK_UI history panel visible");
        } else if (action.equals("check-history")) {
            String expected = getParams().getString("expected", "false");
            assertTrue("DISK_UI invalid expected value", expected.equals("true") || expected.equals("false"));
            UiObject count = control("disk:history:count"); assertTrue("DISK_UI history count missing", count.waitForExists(5000));
            assertEquals("DISK_UI history count mismatch", expected.equals("false"), count.getText().equals("保持件数: 0"));
            System.out.println("DISK_UI history count matches expected");
        } else if (action.equals("clear-history")) {
            control("disk:history:clear").click();
            assertTrue("DISK_UI history did not clear", control("disk:history:empty").waitForExists(5000));
            System.out.println("DISK_UI history cleared");
        } else if (action.equals("close-history")) {
            control("disk:history:back").click();
            assertTrue("DISK_UI settings missing after history", new UiObject(new UiSelector().packageName("com.discord").text("disk 設定")).waitForExists(5000));
            System.out.println("DISK_UI history closed");
        } else if (action.equals("toggle-platform") || action.equals("check-platform")) {
            String place = getParams().getString("feature", "");
            assertTrue("DISK_UI invalid platform location", place.equals("avatars") || place.equals("dmList") || place.equals("dmHeader")
                || place.equals("memberList") || place.equals("profile") || place.equals("messages"));
            if (action.equals("toggle-platform")) {
                String current = getParams().getString("expected", "false");
                assertTrue("DISK_UI invalid current value", current.equals("true") || current.equals("false"));
                assertTrue("DISK_UI initial platform state mismatch", scrolled("disk:platform:" + place + ":" + current).waitForExists(5000));
                UiObject toggle = control("disk:platform:" + place);
                assertTrue("DISK_UI platform control missing", toggle.waitForExists(5000));
                toggle.click(); getUiDevice().waitForIdle();
                assertTrue("DISK_UI platform click did not change state", control("disk:platform:" + place + ":" + !Boolean.parseBoolean(current)).waitForExists(5000));
                System.out.println("DISK_UI platform location toggled");
            } else {
                String expected = getParams().getString("expected", "false");
                assertTrue("DISK_UI invalid expected value", expected.equals("true") || expected.equals("false"));
                assertTrue("DISK_UI platform state mismatch", scrolled("disk:platform:" + place + ":" + expected).waitForExists(5000));
                System.out.println("DISK_UI platform location matches expected");
            }
        } else if (action.equals("toggle-feature") || action.equals("check-feature")) {
            String feature = getParams().getString("feature", "");
            boolean extra = feature.equals("quickDelete") || feature.equals("noConfirmPin") || feature.equals("alwaysTrust") || feature.equals("jumpToTop") || feature.equals("gestures") || feature.equals("gestureTripleDelete") || feature.equals("fullImages") || feature.equals("readAll") || feature.equals("quietReplies") || feature.equals("voiceDownload") || feature.equals("serverInfo") || feature.equals("hiddenChannels") || feature.equals("messageHistory");
            assertTrue("DISK_UI invalid feature", extra || feature.equals("fakeNitro") || feature.equals("platformIndicator"));
            String prefix = extra ? "disk:extra:" : "disk:feature:";
            if (action.equals("toggle-feature")) {
                String current = getParams().getString("expected", "false");
                assertTrue("DISK_UI invalid current value", current.equals("true") || current.equals("false"));
                assertTrue("DISK_UI feature row missing", scrolled(new UiSelector().packageName("com.discord").descriptionStartsWith(prefix + feature + ":")).waitForExists(5000));
                UiObject toggle = control(prefix + feature);
                assertTrue("DISK_UI feature control missing", toggle.waitForExists(5000));
                assertEquals("DISK_UI initial feature state mismatch", Boolean.parseBoolean(current), toggle.isChecked());
                toggle.click();
                getUiDevice().waitForIdle();
                assertEquals("DISK_UI feature click did not change state", !Boolean.parseBoolean(current), control(prefix + feature).isChecked());
                System.out.println("DISK_UI feature toggled");
            } else {
                String expected = getParams().getString("expected", "false");
                assertTrue("DISK_UI invalid expected value", expected.equals("true") || expected.equals("false"));
                assertTrue("DISK_UI feature row missing", scrolled(new UiSelector().packageName("com.discord").descriptionStartsWith(prefix + feature + ":")).waitForExists(5000));
                assertEquals("DISK_UI feature state mismatch", Boolean.parseBoolean(expected), control(prefix + feature).isChecked());
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

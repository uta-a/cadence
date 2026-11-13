package app.cadence.test;

import android.graphics.Rect;
import com.android.uiautomator.core.UiObject;
import com.android.uiautomator.core.UiScrollable;
import com.android.uiautomator.core.UiSelector;
import com.android.uiautomator.testrunner.UiAutomatorTestCase;
import java.util.HashMap;
import java.util.Map;

/**
 * Test only Cadence-owned controls. Never dump account/chat UI or take screenshots.
 * The page is drawn with Discord's TableRow components, so rows are found by their visible labels:
 * a switch row's description is "label, sub label".
 */
public class CadenceUiSmoke extends UiAutomatorTestCase {
    private static final Map<String, String> LABELS = new HashMap<String, String>();
    static {
        LABELS.put("fakeNitro", "Fake Nitro");
        LABELS.put("platformIndicator", "Platform Indicator");
        LABELS.put("avatars", "その他のアバター");
        LABELS.put("dmList", "DM一覧の行");
        LABELS.put("dmHeader", "DMヘッダー");
        LABELS.put("memberList", "メンバー一覧");
        LABELS.put("profile", "プロフィール名");
        LABELS.put("messages", "メッセージの名前");
    }
    private UiSelector discord() {
        return new UiSelector().packageName("com.discord");
    }
    private UiObject row(String label) {
        return new UiObject(discord().descriptionStartsWith(label + ",").enabled(true));
    }
    private UiObject pageHeader() {
        return new UiObject(discord().text("メッセージ"));
    }
    /** The page grows with each category; scroll the named row into view before using it. */
    private UiObject scrolled(UiSelector selector) throws Exception {
        UiScrollable page = new UiScrollable(discord().scrollable(true));
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
    private String label(String name) {
        String value = LABELS.get(name);
        assertNotNull("CADENCE_UI invalid feature or place", value);
        return value;
    }
    public void testNamedAction() throws Exception {
        String action = getParams().getString("action", "open-cadence");
        String expected = getParams().getString("expected", "false");
        assertTrue("CADENCE_UI invalid expected value", expected.equals("true") || expected.equals("false"));
        if (action.equals("open-cadence")) {
            UiObject entry = new UiObject(discord().descriptionStartsWith("Cadence").enabled(true));
            assertTrue("CADENCE_UI Cadence entry missing", entry.waitForExists(15000));
            entry.click();
            assertTrue("CADENCE_UI page missing", pageHeader().waitForExists(5000));
            System.out.println("CADENCE_UI Cadence page visible");
        } else if (action.equals("show-logs")) {
            UiObject logs = scrolled(discord().descriptionStartsWith("診断ログを表示"));
            assertTrue("CADENCE_UI log row missing", logs.waitForExists(5000));
            logs.click();
            assertTrue("CADENCE_UI logs did not open", new UiObject(discord().descriptionStartsWith("診断ログを閉じる")).waitForExists(5000));
            System.out.println("CADENCE_UI memory logs visible");
        } else if (action.equals("check-saved")) {
            assertTrue("CADENCE_UI save acknowledgement missing", scrolled(discord().text("保存しました")).waitForExists(10000));
            System.out.println("CADENCE_UI native save and read-back acknowledged");
        } else if (action.equals("close-cadence")) {
            assertTrue("CADENCE_UI page missing", pageHeader().exists());
            getUiDevice().pressBack();
            getUiDevice().waitForIdle();
            assertTrue("CADENCE_UI overview entry missing after back",
                new UiObject(discord().descriptionStartsWith("Cadence")).waitForExists(5000));
            System.out.println("CADENCE_UI hardware back preserved overview");
        } else if (action.equals("toggle-feature") || action.equals("toggle-platform")) {
            String name = label(getParams().getString("feature", ""));
            UiObject toggle = scrolled(discord().descriptionStartsWith(name + ","));
            assertTrue("CADENCE_UI row missing", toggle.waitForExists(5000));
            assertEquals("CADENCE_UI initial state mismatch", Boolean.parseBoolean(expected), toggle.isChecked());
            toggle.click();
            getUiDevice().waitForIdle();
            assertEquals("CADENCE_UI click did not change state", !Boolean.parseBoolean(expected), row(name).isChecked());
            System.out.println("CADENCE_UI row toggled");
        } else if (action.equals("check-feature") || action.equals("check-platform")) {
            String name = label(getParams().getString("feature", ""));
            assertTrue("CADENCE_UI row missing", scrolled(discord().descriptionStartsWith(name + ",")).waitForExists(5000));
            assertEquals("CADENCE_UI state mismatch", Boolean.parseBoolean(expected), row(name).isChecked());
            System.out.println("CADENCE_UI row matches expected");
        } else {
            fail("CADENCE_UI unsupported action");
        }
    }
}

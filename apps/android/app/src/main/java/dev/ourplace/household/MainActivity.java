package dev.ourplace.household;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state) {
        registerPlugin(HouseholdPlugin.class);
        super.onCreate(state);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            private boolean pending;
            private void fallback() {
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
            @Override public void handleOnBackPressed() {
                if (pending) return;
                if (getBridge() == null || getBridge().getWebView() == null) { fallback(); return; }
                pending = true;
                getBridge().getWebView().evaluateJavascript(
                    "!window.dispatchEvent(new CustomEvent('ourplace:back', {cancelable:true}))",
                    consumed -> {
                        pending = false;
                        if (!"true".equals(consumed)) fallback();
                    }
                );
            }
        });
    }
}

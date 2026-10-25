package dev.lanesignal.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins register before the bridge starts.
        registerPlugin(SecureStoragePlugin.class);
        super.onCreate(savedInstanceState);
    }
}

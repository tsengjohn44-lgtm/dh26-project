// 1. Calculates distance from an ultrasonic sensor
// 2. Sends distance data to the narrator server on the laptop (narrator/server.js)
// 3. Detects if ultrasonic sensor is being obscured and triggers alert buzzer
// 		- This is separate from the generated audio in the main app!
// 4. Diagnostics: each reading also reports uptime, Wi-Fi signal, Wi-Fi drop count and the
//    last reset reason, so the server can tell a reboot (power problem) from a Wi-Fi drop.
//    Built-in LED: solid = Wi-Fi connected, blinking = not connected.

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>

// Wi-Fi Credentials
const char* ssid = "NoozAboode";
const char* password = "bruhbruh";

// Narrator server (narrator/server.js) on the laptop. Use the address it prints at startup
// ("ESP8266: set serverUrl to ..."); the laptop must be on the same Wi-Fi as this board.
const char* serverUrl = "http://10.44.148.136:8080/distance";

// Pin Definitions
const int trigPin = 12;   // D6 maps to GPIO 12
const int echoPin = 14;   // D5 maps to GPIO 14
const int buzzerPin = 16; // D0 maps to GPIO 16
const int ledPin = LED_BUILTIN; // GPIO 2 on NodeMCU / ESP-12, lit when LOW

// Diagnostics
String resetReason;          // why the board last started ("Power On", "Hardware Watchdog", ...)
unsigned long wifiDrops = 0; // times Wi-Fi went from connected to disconnected since boot
bool wasConnected = false;

// Spaces and slashes in the reset reason must be escaped in a form body.
String urlEncode(const String& s) {
  String out;
  for (unsigned int i = 0; i < s.length(); i++) {
    char c = s[i];
    if (isalnum(c) || c == '-' || c == '_' || c == '.') out += c;
    else { char buf[4]; snprintf(buf, sizeof(buf), "%%%02X", (unsigned char)c); out += buf; }
  }
  return out;
}

// Helper function to handle sending data over Wi-Fi
void sendDataToServer(const String& distance) {
  WiFiClient client;
  HTTPClient http;
  http.setTimeout(250); // Fast timeout to prevent loops from freezing
  if (!http.begin(client, serverUrl)) return;
  http.addHeader("Content-Type", "application/x-www-form-urlencoded");
  String body = "distance=" + distance
    + "&uptime=" + String(millis())
    + "&rssi=" + String(WiFi.RSSI())
    + "&drops=" + String(wifiDrops)
    + "&reset=" + urlEncode(resetReason);
  int code = http.POST(body);
  if (code != 204) Serial.printf("POST failed: %d (%s)\n", code, http.errorToString(code).c_str());
  http.end();
}

void setup() {
  Serial.begin(9600);
  resetReason = ESP.getResetReason();
  Serial.printf("\nBooted. Reset reason: %s\n", resetReason.c_str());

  pinMode(trigPin, OUTPUT);
  pinMode(echoPin, INPUT);
  pinMode(buzzerPin, OUTPUT);
  pinMode(ledPin, OUTPUT);

  // Turn off buzzer initially
  digitalWrite(buzzerPin, LOW);
  digitalWrite(ledPin, HIGH); // LED off

  WiFi.persistent(false);         // don't rewrite flash with credentials on every boot
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);    // rejoin automatically after a drop
  WiFi.setSleepMode(WIFI_NONE_SLEEP); // modem sleep can cause dropouts with some access points
  WiFi.begin(ssid, password);
  Serial.println("Connecting to Wi-Fi...");
}

void loop() {
  // 0. Track Wi-Fi state: count drops, show it on the LED and the serial monitor
  bool connected = WiFi.status() == WL_CONNECTED;
  if (connected != wasConnected) {
    if (connected) Serial.printf("Wi-Fi connected: IP %s, signal %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    else { wifiDrops++; Serial.printf("Wi-Fi lost (status %d), drop #%lu\n", WiFi.status(), wifiDrops); }
    wasConnected = connected;
  }
  digitalWrite(ledPin, connected ? LOW : ((millis() / 250) % 2 ? LOW : HIGH)); // solid on / blinking

  // 1. Trigger the Ultrasonic Sensor
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);

  // 2. Read pulse with a 30ms timeout (~4m maximum range)
  long duration = pulseIn(echoPin, HIGH, 30000);

  // 3. Handle Distance Logic
  if (duration == 0) {
    Serial.println("Distance: Out of Range (> 4m)");
    digitalWrite(buzzerPin, LOW); // Turn off buzzer when out of range

    if (connected) {
      sendDataToServer("Out_of_Range");
    }
  } else {
    // Calculate distance in meters
    float distanceMeters = (duration * 0.034 / 2) / 100.0;

    Serial.print("Distance: ");
    Serial.print(distanceMeters, 3);
    Serial.println(" m");

    // 4. Proximity Warning Check (< 0.2 meters)
    if (distanceMeters < 0.050) {
      // DRIVE PIN WITH LOWER VOLTAGE (Software PWM):
      // On ESP8266, analogWrite ranges from 0 (0V) to 1023 (3.3V).
      // 150 gives roughly 15% power/voltage equivalent, making it much quieter.
      analogWrite(buzzerPin, 20);
    } else {
      // Distance is safe, turn buzzer off
      analogWrite(buzzerPin, 0);
    }

    if (connected) {
      sendDataToServer(String(distanceMeters, 3));
    }
  }

  // Fast scroll update rate
  delay(200);
}

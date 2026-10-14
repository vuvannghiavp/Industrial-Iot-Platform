#include "esp_event.h"
#include "mqtt_client.h"
extern char esp_ip[16];
extern bool wifi_connected;
extern esp_mqtt_client_handle_t client;
void mqtt_app_start(void);
void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data);
void publish_motion_data(esp_mqtt_client_handle_t client, uint8_t motion_detected);
void publish_dht22_data(esp_mqtt_client_handle_t client, float temp, float humidity);
void publish_lux_data(esp_mqtt_client_handle_t client,float lux);
void publish_feedback(esp_mqtt_client_handle_t client, const char *device, const char *state);
void publish_led_status(esp_mqtt_client_handle_t client, const char *payload);
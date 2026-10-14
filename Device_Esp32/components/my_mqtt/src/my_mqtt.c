
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include <inttypes.h>
#include <time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_system.h"
#include "esp_log.h"
#include "sdkconfig.h"
#include "my_mqtt.h"
#include "confi.h"
#include "cJSON.h"
#include "esp_err.h"

extern char esp_ip[16];
extern bool wifi_connected;

esp_mqtt_client_handle_t client = NULL;
static const char *TAG = "MQTT";
static char *s_mqtt_payload_buf = NULL;
static size_t s_mqtt_payload_expected_len = 0;
static char s_mqtt_topic_buf[256] = {0};

static bool valid_topic_id(const char *id)
{
    if (id == NULL || id[0] == '\0')
    {
        return false;
    }
    for (const char *cursor = id; *cursor != '\0'; cursor++)
    {
        if (!((*cursor >= 'a' && *cursor <= 'z') ||
              (*cursor >= '0' && *cursor <= '9') || *cursor == '-'))
        {
            return false;
        }
    }
    return true;
}

static bool make_home_topic(char *topic, size_t topic_size, const char *suffix)
{
    if (!valid_topic_id(CONFIG_HOME_USER_ID) ||
        !valid_topic_id(CONFIG_HOME_ROOM_ID) ||
        !valid_topic_id(CONFIG_HOME_DEVICE_ID) ||
        suffix == NULL || suffix[0] == '\0')
    {
        ESP_LOGE(TAG, "Invalid home MQTT topic identity or suffix");
        return false;
    }
    for (const char *cursor = suffix; *cursor != '\0'; cursor++)
    {
        if (*cursor == '/')
        {
            if (cursor == suffix || cursor[1] == '\0' || cursor[1] == '/')
            {
                ESP_LOGE(TAG, "Invalid home MQTT topic suffix");
                return false;
            }
        }
        else if (!( (*cursor >= 'a' && *cursor <= 'z') ||
                    (*cursor >= '0' && *cursor <= '9') || *cursor == '-' ||
                    (strcmp(suffix, "command/#") == 0 && *cursor == '#')))
        {
            ESP_LOGE(TAG, "Invalid home MQTT topic suffix");
            return false;
        }
    }
    int length = snprintf(topic, topic_size, "home/v1/%s/%s/%s/%s",
                          CONFIG_HOME_USER_ID, CONFIG_HOME_ROOM_ID,
                          CONFIG_HOME_DEVICE_ID, suffix);
    if (length < 0 || (size_t)length >= topic_size)
    {
        ESP_LOGE(TAG, "Home MQTT topic exceeds buffer capacity");
        return false;
    }
    return true;
}

static bool is_home_topic(const char *topic, const char *suffix)
{
    char expected_topic[256];
    return make_home_topic(expected_topic, sizeof(expected_topic), suffix) &&
           strcmp(topic, expected_topic) == 0;
}

static int publish_home_topic(esp_mqtt_client_handle_t mqtt_client,
                              const char *suffix,
                              const char *payload,
                              int qos,
                              int retain)
{
    char topic[256];
    if (!make_home_topic(topic, sizeof(topic), suffix))
    {
        return -1;
    }
    return esp_mqtt_client_publish(mqtt_client, topic, payload, 0, qos, retain);
}

static void add_reading_timestamp(cJSON *reading)
{
    time_t now = time(NULL);
    struct tm utc_time = {0};
    char timestamp[25];
    if (now < 1577836800 || gmtime_r(&now, &utc_time) == NULL ||
        strftime(timestamp, sizeof(timestamp), "%Y-%m-%dT%H:%M:%SZ", &utc_time) == 0)
    {
        ESP_LOGW(TAG, "Sensor reading timestamp unavailable; SNTP may not be synchronized");
        return;
    }
    cJSON_AddStringToObject(reading, "timestamp", timestamp);
}

static void apply_fan_state(bool fan_on, int speed_percent);
void mqtt_data_dispatch(const char *topic, int topic_len,
                        const char *data, int data_len);
static bool parse_on_off_state(const cJSON *state_item, bool *state)
{
    if (state_item == NULL || state == NULL)
    {
        return false;
    }

    if (cJSON_IsBool(state_item))
    {
        *state = cJSON_IsTrue(state_item);
        return true;
    }

    if (cJSON_IsNumber(state_item))
    {
        *state = state_item->valueint != 0;
        return true;
    }

    if (cJSON_IsString(state_item) && state_item->valuestring != NULL)
    {
        const char *value = state_item->valuestring;
        if (strcmp(value, "ON") == 0 || strcmp(value, "on") == 0 ||
            strcmp(value, "true") == 0 || strcmp(value, "TRUE") == 0 ||
            strcmp(value, "1") == 0)
        {
            *state = true;
            return true;
        }
        if (strcmp(value, "OFF") == 0 || strcmp(value, "off") == 0 ||
            strcmp(value, "false") == 0 || strcmp(value, "FALSE") == 0 ||
            strcmp(value, "0") == 0)
        {
            *state = false;
            return true;
        }
    }

    return false;
}

static bool parse_command_state(const cJSON *root, bool *state)
{
    cJSON *state_item = cJSON_GetObjectItem(root, "state");
    if (state_item != NULL)
    {
        return parse_on_off_state(state_item, state);
    }

    cJSON *action_item = cJSON_GetObjectItem(root, "action");
    if (cJSON_IsString(action_item) && action_item->valuestring != NULL)
    {
        if (strcmp(action_item->valuestring, "turn_on") == 0)
        {
            *state = true;
            return true;
        }
        if (strcmp(action_item->valuestring, "turn_off") == 0)
        {
            *state = false;
            return true;
        }
    }
    return false;
}

static void handle_fan_speed(const char *data, int data_len);
static void publish_fan_speed_raw(int speed_percent);

static void handle_complete_mqtt_message(const char *topic, const char *payload, size_t payload_len)
{
    if (is_home_topic(topic, "command/fan/speed"))
    {
        handle_fan_speed(payload, (int)payload_len);
        return;
    }

    cJSON *root = cJSON_ParseWithLength(payload, payload_len);
    if (root == NULL)
    {
        ESP_LOGW(TAG, "MQTT_EVENT_DATA payload parse failed");
        return;
    }

    bool published_feedback = false;
    char feedback_device[16] = {0};
    char feedback_state[16] = {0};

    if (is_home_topic(topic, "command/led"))
    {
        bool led_on;
        if (!parse_command_state(root, &led_on))
        {
            ESP_LOGW(TAG, "Ignoring invalid LED command payload");
            cJSON_Delete(root);
            return;
        }
        gpio_set_level(RELAY1_GPIO, led_on ? 1 : 0);
        s_equipment_status.led_state = led_on;
        strcpy(feedback_device, "led");
        strcpy(feedback_state, led_on ? "ON" : "OFF");
        ESP_LOGI(TAG, "[LED SET] Đèn %s", led_on ? "BẬT" : "TẮT");
        published_feedback = true;
    }
    else if (is_home_topic(topic, "command/fan"))
    {
        bool fan_on;
        if (!parse_command_state(root, &fan_on))
        {
            ESP_LOGW(TAG, "Ignoring invalid fan command payload");
            cJSON_Delete(root);
            return;
        }
        apply_fan_state(fan_on, fan_on ? 100 : 0);
        strcpy(feedback_device, "fan");
        strcpy(feedback_state, fan_on ? "ON" : "OFF");
        ESP_LOGI(TAG, "[FAN SET] Quạt %s", fan_on ? "BẬT" : "TẮT");
        published_feedback = true;
    }
    else
    {
        mqtt_data_dispatch(topic, (int)strlen(topic), payload, (int)payload_len);
    }

    if (published_feedback)
    {
        publish_feedback(client, feedback_device, feedback_state);
    }

    cJSON_Delete(root);
}

static void publish_fan_status(bool fan_on, int speed_percent)
{
    if (speed_percent < 0)
    {
        speed_percent = fan_on ? 100 : 0;
    }
    if (speed_percent > 100)
    {
        speed_percent = 100;
    }
    if (speed_percent < 0)
    {
        speed_percent = 0;
    }

    int pwm_value = fan_on ? (speed_percent * 255) / 100 : 0;
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "device", "fan");
    cJSON_AddStringToObject(root, "state", fan_on ? "ON" : "OFF");
    cJSON_AddNumberToObject(root, "speed", speed_percent);
    cJSON_AddNumberToObject(root, "pwm", pwm_value);
    char *payload = cJSON_PrintUnformatted(root);
    publish_home_topic(client, "state/fan", payload, 1, 1);
    cJSON_Delete(root);
    free(payload);

    publish_fan_speed_raw(speed_percent);
}

static void publish_fan_speed_raw(int speed_percent)
{
    if (speed_percent < 0)
    {
        speed_percent = 0;
    }
    if (speed_percent > 100)
    {
        speed_percent = 100;
    }

    char payload[8];
    snprintf(payload, sizeof(payload), "%d", speed_percent);
    publish_home_topic(client, "state/fan/speed", payload, 1, 1);
}

static void apply_fan_state(bool fan_on, int speed_percent)
{
    if (speed_percent < 0)
    {
        speed_percent = fan_on ? 100 : 0;
    }
    if (speed_percent > 100)
    {
        speed_percent = 100;
    }
    if (speed_percent < 0)
    {
        speed_percent = 0;
    }

    int pwm_value = fan_on ? (speed_percent * 255) / 100 : 0;
    gpio_set_level(RELAY2_GPIO, fan_on ? 1 : 0);
    ledc_set_duty(PWM_MODE, PWM_CHANNEL, pwm_value);
    ledc_update_duty(PWM_MODE, PWM_CHANNEL);
    s_equipment_status.fan_state = fan_on;
    s_equipment_status.fan_speed = fan_on ? speed_percent : 0;
    publish_fan_status(fan_on, speed_percent);
}

// HÀM 1: Xử lý tốc độ quạt (fan/speed/set)
// ================================================================
static void handle_fan_speed(const char *data, int data_len)
{
    cJSON *root = cJSON_ParseWithLength(data, data_len);
    int speed_percent = -1;
    int pwm_value = -1;

    if (root == NULL)
    {
        // Some MQTT panel widgets may publish a raw number or a quoted string
        // instead of a JSON object. Accept those forms as a fallback.
        char raw_payload[16] = {0};
        int copy_len = data_len < (int)sizeof(raw_payload) - 1 ? data_len : (int)sizeof(raw_payload) - 1;
        memcpy(raw_payload, data, copy_len);
        raw_payload[copy_len] = '\0';

        if (raw_payload[0] == '"' && copy_len >= 2)
        {
            memmove(raw_payload, raw_payload + 1, copy_len - 2);
            raw_payload[copy_len - 2] = '\0';
        }

        char *endptr = NULL;
        long raw_value = strtol(raw_payload, &endptr, 10);
        if (endptr != raw_payload && raw_value >= 0)
        {
            if (raw_value <= 100)
            {
                speed_percent = (int)raw_value;
                pwm_value = (speed_percent * 255) / 100;
            }
            else if (raw_value <= 255)
            {
                pwm_value = (int)raw_value;
                speed_percent = (pwm_value * 100) / 255;
            }
            else
            {
                pwm_value = 255;
                speed_percent = 100;
            }
        }

        if (speed_percent < 0 && pwm_value < 0)
        {
            ESP_LOGE(TAG, "[FAN] Lỗi parse JSON hoặc payload số thô không hợp lệ: %s", raw_payload);
            return;
        }
    }
    else if (cJSON_IsNumber(root))
    {
        speed_percent = root->valueint;
        if (speed_percent > 100)
        {
            speed_percent = 100;
        }
        if (speed_percent < 0)
        {
            speed_percent = 0;
        }
        pwm_value = (speed_percent * 255) / 100;
    }
    else if (cJSON_IsString(root) && root->valuestring != NULL)
    {
        char *endptr = NULL;
        long raw_value = strtol(root->valuestring, &endptr, 10);
        if (endptr != root->valuestring && raw_value >= 0)
        {
            if (raw_value <= 100)
            {
                speed_percent = (int)raw_value;
                pwm_value = (speed_percent * 255) / 100;
            }
            else if (raw_value <= 255)
            {
                pwm_value = (int)raw_value;
                speed_percent = (pwm_value * 100) / 255;
            }
            else
            {
                pwm_value = 255;
                speed_percent = 100;
            }
        }
        else
        {
            ESP_LOGE(TAG, "[FAN] Payload chuỗi không hợp lệ: %s", root->valuestring);
            cJSON_Delete(root);
            return;
        }
    }
    else
    {
        cJSON *speed_item = cJSON_GetObjectItem(root, "speed");
        cJSON *pwm_item = cJSON_GetObjectItem(root, "pwm");

        bool speed_is_number = cJSON_IsNumber(speed_item);
        bool speed_is_string = cJSON_IsString(speed_item) && speed_item->valuestring != NULL;
        bool pwm_is_number = cJSON_IsNumber(pwm_item);
        bool pwm_is_string = cJSON_IsString(pwm_item) && pwm_item->valuestring != NULL;

        if (!speed_is_number && !speed_is_string && !pwm_is_number && !pwm_is_string)
        {
            ESP_LOGW(TAG, "[FAN] Payload thiếu 'speed' hoặc 'pwm'");
            cJSON_Delete(root);
            return;
        }

        if (speed_is_number)
        {
            speed_percent = speed_item->valueint;
        }
        else if (speed_is_string)
        {
            speed_percent = atoi(speed_item->valuestring);
        }

        if (pwm_is_number)
        {
            pwm_value = pwm_item->valueint;
        }
        else if (pwm_is_string)
        {
            pwm_value = atoi(pwm_item->valuestring);
        }

        if (pwm_value < 0 && speed_percent >= 0)
        {
            if (speed_percent > 100)
                speed_percent = 100;
            if (speed_percent < 0)
                speed_percent = 0;
            pwm_value = (speed_percent * 255) / 100;
        }
        if (pwm_value > 255)
            pwm_value = 255;
        if (pwm_value < 0)
            pwm_value = 0;
    }

    if (!s_equipment_status.fan_state && speed_percent > 0)
    {
        ESP_LOGW(TAG, "[FAN] Slider PWM bị bỏ qua vì quạt đang OFF. Dùng nút bật quạt trước khi chỉnh tốc độ.");
        speed_percent = 0;
        pwm_value = 0;
    }

    apply_fan_state(pwm_value > 0, speed_percent >= 0 ? speed_percent : (pwm_value * 100 / 255));

    ESP_LOGI(TAG, "[FAN] Đã set tốc độ: %d%% (PWM=%d)", speed_percent, pwm_value);

    cJSON *status = cJSON_CreateObject();
    cJSON_AddNumberToObject(status, "speed", speed_percent);
    cJSON_AddNumberToObject(status, "pwm", pwm_value);
    cJSON_AddStringToObject(status, "state", s_equipment_status.fan_state ? "ON" : "OFF");
    cJSON_AddStringToObject(status, "device", "fan");
    char *out = cJSON_PrintUnformatted(status);
    publish_home_topic(client, "state/fan", out, 1, 1);
    cJSON_free(out);
    cJSON_Delete(status);

    cJSON_Delete(root);
}

// ================================================================
// Xử lý chuyển đổi chế độ LED (Auto/Manual)
// ================================================================
static void handle_led_mode_switch(const char *data, int data_len)
{
    cJSON *root = cJSON_ParseWithLength(data, data_len);
    if (root == NULL)
    {
        ESP_LOGE(TAG, "[LED MODE] Lỗi parse JSON");
        return;
    }

    cJSON *mode_item = cJSON_GetObjectItem(root, "mode");
    if (!cJSON_IsString(mode_item))
    {
        ESP_LOGW(TAG, "[LED MODE] Payload thiếu 'mode' (auto/manual)");
        cJSON_Delete(root);
        return;
    }

    const char *mode_str = mode_item->valuestring;
    bool auto_mode = (strcmp(mode_str, "auto") == 0);

    s_equipment_status.led_auto_mode = auto_mode;
    ESP_LOGI(TAG, "[LED MODE] Chuyển sang: %s", auto_mode ? "AUTO" : "MANUAL");

    // Phản hồi lại dashboard
    cJSON *response = cJSON_CreateObject();
    cJSON_AddStringToObject(response, "mode", auto_mode ? "auto" : "manual");
    cJSON_AddBoolToObject(response, "success", true);
    char *out = cJSON_PrintUnformatted(response);
    publish_home_topic(client, "state/led/mode", out, 1, 1);
    cJSON_free(out);
    cJSON_Delete(response);

    cJSON_Delete(root);
}

// ================================================================
// Xử lý bật/tắt đèn MANUAL
// ================================================================
static void handle_led_manual_control(const char *data, int data_len)
{
    cJSON *root = cJSON_ParseWithLength(data, data_len);
    if (root == NULL)
    {
        ESP_LOGE(TAG, "[LED MANUAL] Lỗi parse JSON");
        return;
    }

    cJSON *state_item = cJSON_GetObjectItem(root, "state");
    if (!cJSON_IsBool(state_item) && !cJSON_IsNumber(state_item))
    {
        ESP_LOGW(TAG, "[LED MANUAL] Payload thiếu 'state' (true/false)");
        cJSON_Delete(root);
        return;
    }

    bool led_on = cJSON_IsTrue(state_item) || (cJSON_IsNumber(state_item) && state_item->valueint != 0);

    // Chỉ điều khiển thủ công khi ở chế độ MANUAL
    if (!s_equipment_status.led_auto_mode)
    {
        gpio_set_level(RELAY1_GPIO, led_on ? 1 : 0);
        s_equipment_status.led_state = led_on;
        ESP_LOGI(TAG, "[LED MANUAL] Đèn: %s", led_on ? "BẬT" : "TẮT");
    }
    else
    {
        ESP_LOGW(TAG, "[LED MANUAL] Ở chế độ AUTO, không thể điều khiển thủ công");
    }

    // Phản hồi lại
    cJSON *response = cJSON_CreateObject();
    cJSON_AddBoolToObject(response, "state", s_equipment_status.led_state);
    cJSON_AddBoolToObject(response, "auto_mode", s_equipment_status.led_auto_mode);
    char *out = cJSON_PrintUnformatted(response);
    publish_home_topic(client, "state/led/control", out, 1, 1);
    cJSON_free(out);
    cJSON_Delete(response);

    cJSON_Delete(root);
}

void mqtt_data_dispatch(const char *topic, int topic_len,
                        const char *data, int data_len)
{
    (void)topic_len;
    if (is_home_topic(topic, "command/fan/speed"))
    {
        handle_fan_speed(data, data_len);
    }
    else if (is_home_topic(topic, "command/led/mode"))
    {
        handle_led_mode_switch(data, data_len);
    }
    else if (is_home_topic(topic, "command/led/control"))
    {
        handle_led_manual_control(data, data_len);
    }
}
// static void log_error_if_nonzero(const char *message, int error_code)
// {
//     if (error_code != 0)
//     {
//         ESP_LOGE(TAG, "Last error %s: 0x%x", message, error_code);
//     }
// }
// 2. GỬI DỮ LIỆU CẢM BIẾN LÊN WEB DASHBOARD:
void publish_dht22_data(esp_mqtt_client_handle_t client, float temp, float humidity)
{
    char suffix[128];
    cJSON *temperature = cJSON_CreateObject();
    cJSON_AddNumberToObject(temperature, "value", temp);
    cJSON_AddStringToObject(temperature, "unit", "Cel");
    cJSON_AddStringToObject(temperature, "quality", "good");
    add_reading_timestamp(temperature);
    char *temperature_payload = cJSON_PrintUnformatted(temperature);
    snprintf(suffix, sizeof(suffix), "telemetry/%s/temperature",
             CONFIG_HOME_TEMPERATURE_SENSOR_ID);
    publish_home_topic(client, suffix, temperature_payload, 1, 0);
    cJSON_Delete(temperature);
    free(temperature_payload);

    cJSON *humidity_json = cJSON_CreateObject();
    cJSON_AddNumberToObject(humidity_json, "value", humidity);
    cJSON_AddStringToObject(humidity_json, "unit", "%");
    cJSON_AddStringToObject(humidity_json, "quality", "good");
    add_reading_timestamp(humidity_json);
    char *humidity_payload = cJSON_PrintUnformatted(humidity_json);
    snprintf(suffix, sizeof(suffix), "telemetry/%s/humidity",
             CONFIG_HOME_HUMIDITY_SENSOR_ID);
    publish_home_topic(client, suffix, humidity_payload, 1, 0);
    cJSON_Delete(humidity_json);
    free(humidity_payload);
}
void publish_lux_data(esp_mqtt_client_handle_t client, float lux)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "value", lux);
    cJSON_AddStringToObject(root, "unit", "lx");
    cJSON_AddStringToObject(root, "quality", "good");
    add_reading_timestamp(root);

    char *payload = cJSON_PrintUnformatted(root);
    char suffix[128];
    snprintf(suffix, sizeof(suffix), "telemetry/%s/illuminance",
             CONFIG_HOME_ILLUMINANCE_SENSOR_ID);
    publish_home_topic(client, suffix, payload, 1, 0);

    cJSON_Delete(root);
    free(payload);
}
void publish_motion_data(esp_mqtt_client_handle_t client, uint8_t motion_detected)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddBoolToObject(root, "value", motion_detected != 0);
    cJSON_AddStringToObject(root, "unit", "bool");
    cJSON_AddStringToObject(root, "quality", "good");
    add_reading_timestamp(root);

    char *payload = cJSON_PrintUnformatted(root);
    char suffix[128];
    snprintf(suffix, sizeof(suffix), "telemetry/%s/occupancy",
             CONFIG_HOME_MOTION_SENSOR_ID);
    publish_home_topic(client, suffix, payload, 1, 0);

    cJSON_Delete(root);
    free(payload);
}
// void publish_status(esp_mqtt_client_handle_t client)
// {
//     cJSON *root = cJSON_CreateObject();
//     cJSON_AddStringToObject(root, "status", "online");
//     cJSON_AddStringToObject(root, "ip", esp_ip);
//     char *payload = cJSON_PrintUnformatted(root); // convert JSON into 1 string
//     publish_home_topic(client, "availability", payload, 1, 1);
//     // qos = 1, retain = 1
//     cJSON_Delete(root);
//     free(payload);
// }
void publish_feedback(esp_mqtt_client_handle_t client, const char *device, const char *state)
{
    bool device_on = strcmp(state, "ON") == 0;
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "device", device);
    cJSON_AddStringToObject(root, "state", state);
    cJSON_AddBoolToObject(root, "value", device_on);
    cJSON_AddStringToObject(root, "unit", "bool");
    cJSON_AddStringToObject(root, "quality", "good");
    add_reading_timestamp(root);

    char *payload = cJSON_PrintUnformatted(root); // convert JSON into 1 string
    char suffix[48];
    snprintf(suffix, sizeof(suffix), "state/%s", device);
    publish_home_topic(client, suffix, payload, 1, 1);

    cJSON_Delete(root);
    free(payload);
}

void publish_led_status(esp_mqtt_client_handle_t mqtt_client, const char *payload)
{
    publish_home_topic(mqtt_client, "state/led", payload, 1, 1);
}

void publish_status(void)
{
    if (client == NULL)
    {
        return;
    }
    cJSON *status = cJSON_CreateObject();
    cJSON_AddStringToObject(status, "status", "online");
    cJSON_AddStringToObject(status, "ip", esp_ip);
    char *payload = cJSON_PrintUnformatted(status);
    publish_home_topic(client, "availability", payload, 1, 1);
    cJSON_free(payload);
    cJSON_Delete(status);
}

void mqtt_app_start(void)
{
    static char availability_topic[256];
    if (strncmp(CONFIG_HOME_MQTT_BROKER_URI, "mqtt://", 7) != 0)
    {
        ESP_LOGE(TAG, "Local Pi broker must use mqtt:// without TLS certificates");
        return;
    }
    if (CONFIG_HOME_MQTT_PASSWORD[0] == '\0')
    {
        ESP_LOGE(TAG, "HOME_MQTT_PASSWORD must be configured in menuconfig");
        return;
    }
    if (!make_home_topic(availability_topic, sizeof(availability_topic), "availability"))
    {
        return;
    }
    esp_mqtt_client_config_t mqtt_cfg = {
        .broker.address.uri = CONFIG_HOME_MQTT_BROKER_URI,
        .credentials.username = CONFIG_HOME_USER_ID,
        .credentials.authentication.password = CONFIG_HOME_MQTT_PASSWORD,
        .session.keepalive = 30,
        .session.last_will = {
            .topic = availability_topic,
            .msg = "{\"status\":\"offline\"}",
            .msg_len = 20,
            .qos = 1,
            .retain = 1,
        },
    };
    client = esp_mqtt_client_init(&mqtt_cfg);
    esp_mqtt_client_register_event(client, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL);
    esp_mqtt_client_start(client);
}

void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data)
{
    ESP_LOGD(TAG, "Event dispatched from event loop base=%s, event_id=%" PRIi32 "", base, event_id);
    esp_mqtt_event_handle_t event = event_data;
    esp_mqtt_client_handle_t client = event->client;
    switch ((esp_mqtt_event_id_t)event_id)
    {
        // ESP32 kết nối MQTT Broker thành công. Subscribe các topic, gửi trạng thái ban đầu
    case MQTT_EVENT_CONNECTED:
        ESP_LOGI(TAG, "MQTT_EVENT_CONNECTED");
        wifi_connected = true;
        char command_topic[256];
        if (make_home_topic(command_topic, sizeof(command_topic), "command/#"))
        {
            esp_mqtt_client_subscribe(client, command_topic, 1);
        }
        publish_status();
        publish_fan_status(s_equipment_status.fan_state, s_equipment_status.fan_speed);
        break;
        // Biết MQTT đã mất kết nối, ghi log/xử lý trạng thái
    case MQTT_EVENT_DISCONNECTED:
        wifi_connected = false;
        free(s_mqtt_payload_buf);
        s_mqtt_payload_buf = NULL;
        s_mqtt_payload_expected_len = 0;
        s_mqtt_topic_buf[0] = '\0';
        ESP_LOGI(TAG, "MQTT_EVENT_DISCONNECTED");
        break;
        // Kiểm tra việc subscribe đã thành công
    case MQTT_EVENT_SUBSCRIBED:
        ESP_LOGI(TAG, "SUBSRIBED_SUCCECSSFULLY");
        break;
        // Theo dõi việc gửi message
    case MQTT_EVENT_PUBLISHED:
        ESP_LOGI(TAG, "PUBLISH_SUCCECSSFULLY");
        break;
        // ESP32 nhận được message từ topic đã subscribe. Đọc topic + payload và xử lý lệnh/dữ liệu
    case MQTT_EVENT_DATA:
    {
        ESP_LOGI(TAG, "MQTT_EVENT_DATA");
        if (event->current_data_offset == 0)
        {
            free(s_mqtt_payload_buf);
            s_mqtt_payload_buf = NULL;
            s_mqtt_payload_expected_len = (size_t)event->total_data_len;
            memset(s_mqtt_topic_buf, 0, sizeof(s_mqtt_topic_buf));
            snprintf(s_mqtt_topic_buf, sizeof(s_mqtt_topic_buf), "%.*s", event->topic_len, event->topic);
            s_mqtt_payload_buf = malloc(s_mqtt_payload_expected_len + 1);
            if (s_mqtt_payload_buf == NULL)
            {
                ESP_LOGE(TAG, "MQTT_EVENT_DATA payload malloc failed");
                break;
            }
        }
        else if (s_mqtt_payload_buf == NULL)
        {
            ESP_LOGW(TAG, "MQTT_EVENT_DATA received fragmented payload without buffer");
            break;
        }

        if (event->current_data_offset + event->data_len > s_mqtt_payload_expected_len)
        {
            ESP_LOGW(TAG, "MQTT_EVENT_DATA fragment overflow");
            free(s_mqtt_payload_buf);
            s_mqtt_payload_buf = NULL;
            s_mqtt_payload_expected_len = 0;
            break;
        }

        memcpy(s_mqtt_payload_buf + event->current_data_offset, event->data, event->data_len);

        if (event->current_data_offset + event->data_len < s_mqtt_payload_expected_len)
        {
            break;
        }

        s_mqtt_payload_buf[s_mqtt_payload_expected_len] = '\0';
        handle_complete_mqtt_message(s_mqtt_topic_buf, s_mqtt_payload_buf, s_mqtt_payload_expected_len);

        free(s_mqtt_payload_buf);
        s_mqtt_payload_buf = NULL;
        s_mqtt_payload_expected_len = 0;
        s_mqtt_topic_buf[0] = '\0';
        break;
    }
    default:
        ESP_LOGI(TAG, "Other event id:%d", event->event_id);
        break;
    }
}

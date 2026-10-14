#include "sr522.h"
#include "confi.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "SR522";
#define SR522_STARTUP_DELAY_MS 3000
#define SR522_MOTION_HOLD_MS 5000

//static gpio_num_t sr522_config.gpio = GPIO_NUM_NC;
static volatile bool motion_detected = false;
static volatile bool startup_ready = false;
static volatile TickType_t last_motion_tick = 0;
static void sr522_refresh_motion_state(void)
{
    if (!motion_detected)
    {
        return;
    }

    TickType_t now = xTaskGetTickCount();
    TickType_t elapsed = now - last_motion_tick;

    if (elapsed > pdMS_TO_TICKS(SR522_MOTION_HOLD_MS))
    {
        motion_detected = false;
    }
}

/**
 * @brief GPIO interrupt handler
 */
static void IRAM_ATTR sr522_isr_handler(void *arg)
{
    (void)arg;

    if (!startup_ready)
    {
        return;
    }

    if (gpio_get_level(sr522_config.gpio) == 1)
    {
        motion_detected = true;
        last_motion_tick = xTaskGetTickCountFromISR();
    }
}

/**
 * @brief Khởi tạo HC-SR522
 */
esp_err_t sr522_init(const sr522_config_t *config)
{
    if (config == NULL)
    {
        return ESP_ERR_INVALID_ARG;
    }

    sr522_config.gpio = config->gpio;

    gpio_config_t io_conf = {
        .pin_bit_mask = (1ULL << sr522_config.gpio),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_POSEDGE,
    };

    esp_err_t ret = gpio_config(&io_conf);
    if (ret != ESP_OK)
    {
        ESP_LOGE(TAG, "Failed to configure GPIO %d: %s", sr522_config.gpio, esp_err_to_name(ret));
        return ret;
    }

    ret = gpio_install_isr_service(0);
    if (ret != ESP_OK && ret != ESP_ERR_INVALID_STATE)
    {
        ESP_LOGE(TAG, "Failed to install ISR service: %s", esp_err_to_name(ret));
        return ret;
    }
// if it have interupt event, it will call the function sr522_isr_handler
    ret = gpio_isr_handler_add(sr522_config.gpio,
                               sr522_isr_handler,
                               NULL);
    if (ret != ESP_OK)
    {
        ESP_LOGE(TAG, "Failed to add GPIO ISR for GPIO %d: %s", sr522_config.gpio, esp_err_to_name(ret));
        return ret;
    }

    motion_detected = false;
    startup_ready = false;
    last_motion_tick = 0;

    ESP_LOGI(TAG, "Waiting for HC-SR522 startup stabilization...");
    vTaskDelay(pdMS_TO_TICKS(SR522_STARTUP_DELAY_MS));

    startup_ready = true;
    if (gpio_get_level(sr522_config.gpio) == 1)
    {
        motion_detected = true;
        last_motion_tick = xTaskGetTickCount();
    }

    ESP_LOGI(TAG, "HC-SR522 initialized on GPIO %d", sr522_config.gpio);
    return ESP_OK;
}

/**
 * @brief Kiểm tra có chuyển động không
 */
bool sr522_is_motion_detected(void)
{
    if (startup_ready && gpio_get_level(sr522_config.gpio) == 1)
    {
        motion_detected = true;
        last_motion_tick = xTaskGetTickCount();
    }

    sr522_refresh_motion_state();
    return motion_detected;
}

/**
 * @brief Xóa trạng thái chuyển động
 */
void sr522_clear_motion(void)
{
    motion_detected = false;
    last_motion_tick = 0;
}

/**
 * @brief In trạng thái debug của cảm biến ra log
 */
void sr522_debug_print_state(void)
{
    int level = gpio_get_level(sr522_config.gpio);
    sr522_refresh_motion_state();

    ESP_LOGI(TAG, "SR522 debug -> GPIO:%d level:%d motion:%d startup_ready:%d",
             sr522_config.gpio,
             level,
             motion_detected,
             startup_ready);
}

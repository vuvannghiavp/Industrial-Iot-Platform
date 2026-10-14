#ifndef SR522_H
#define SR522_H

#include "driver/gpio.h"
#include "esp_err.h"
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Cấu hình HC-SR522
 */
typedef struct
{
    gpio_num_t gpio;
} sr522_config_t;

/**
 * @brief Khởi tạo HC-SR522
 *
 * @param config cấu hình GPIO
 * @return ESP_OK nếu thành công
 */
esp_err_t sr522_init(const sr522_config_t *config);

/**
 * @brief Đọc trạng thái chuyển động hiện tại
 *
 * @return true  - đang phát hiện chuyển động
 * @return false - không phát hiện
 */
bool sr522_is_motion_detected(void);

/**
 * @brief Xóa trạng thái chuyển động
 */
void sr522_clear_motion(void);

/**
 * @brief In trạng thái debug của cảm biến ra log
 */
void sr522_debug_print_state(void);

#ifdef __cplusplus
}
#endif

#endif
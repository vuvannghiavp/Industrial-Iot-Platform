/**
 * @file zh_bh1750.h
 */

#pragma once

#include "esp_err.h"
#include "esp_log.h"
#include "driver/i2c_master.h"
#include "freertos/FreeRTOS.h"

#define ZH_BH1750_INIT_CONFIG_DEFAULT() \
    {                                   \
        .i2c_frequency = 400000,        \
        .i2c_address = 0x23}

#ifdef __cplusplus
extern "C"
{
#endif

    /**
     * @brief Structure for initial initialization of BH1750 sensor.
     */
    typedef struct
    {
        i2c_master_bus_handle_t i2c_handle; /*!< Unique I2C bus handle. */
        uint8_t i2c_address;                /*!< Sensor I2C address. */
        uint32_t i2c_frequency;             /*!< Sensor I2C frequency. */
    } zh_bh1750_init_config_t;

    /**
     * @brief BH1750 sensor handle.
     */
    typedef struct
    {
        bool is_initialized;                /*!< Sensor initialization flag. */
        i2c_master_dev_handle_t dev_handle; /*!< Unique I2C device handle. */
    } zh_bh1750_handle_t;

    /**
     * @brief Structure for error statistics storage.
     */
    typedef struct
    {
        uint32_t i2c_driver_error; /*!< Number of i2c driver error. */
    } zh_bh1750_stats_t;

    /**
     * @brief Initialize BH1750 sensor.
     *
     * @param[in] config Pointer to BH1750 initialized configuration structure. Can point to a temporary variable.
     * @param[out] handle Pointer to unique BH1750 handle.
     *
     * @attention I2C driver must be initialized first.
     *
     * @note Before initialize the sensor recommend initialize zh_bh1750_init_config_t structure with default values.
     *
     * @code zh_bh1750_init_config_t config = ZH_BH1750_INIT_CONFIG_DEFAULT() @endcode
     *
     * @return ESP_OK if success or an error code otherwise.
     */
    esp_err_t zh_bh1750_init(const zh_bh1750_init_config_t *config, zh_bh1750_handle_t *handle);

    /**
     * @brief Deinitialize PCF8574 expander.
     *
     * @param[in] handle Pointer to unique BH1750 handle.
     *
     * @return ESP_OK if success or an error code otherwise.
     */
    esp_err_t zh_bh1750_deinit(zh_bh1750_handle_t *handle);

    /**
     * @brief Read BH1750 sensor.
     *
     * @param[in] handle Pointer to unique BH1750 handle.
     * @param[out] data Pointer for reading data.
     *
     * @return ESP_OK if success or an error code otherwise.
     */
    esp_err_t zh_bh1750_read(zh_bh1750_handle_t *handle, float *data);

    /**
     * @brief Get error statistics.
     *
     * @return Pointer to the statistics structure.
     */
    const zh_bh1750_stats_t *zh_bh1750_get_stats(void);

    /**
     * @brief Reset error statistics.
     */
    void zh_bh1750_reset_stats(void);

#ifdef __cplusplus
}
#endif
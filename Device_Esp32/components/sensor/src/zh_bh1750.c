#include "zh_bh1750.h"
#include "confi.h"
static const char *TAG = "zh_bh1750";

#define ZH_LOGI(msg, ...) ESP_LOGI(TAG, msg, ##__VA_ARGS__)
#define ZH_LOGE(msg, err, ...) ESP_LOGE(TAG, "[%s:%d:%s] " msg, __FILE__, __LINE__, esp_err_to_name(err), ##__VA_ARGS__)

#define ZH_ERROR_CHECK(cond, err, cleanup, msg, ...) \
    if (!(cond))                                     \
    {                                                \
        ZH_LOGE(msg, err, ##__VA_ARGS__);            \
        cleanup;                                     \
        return err;                                  \
    }

static const uint8_t _bh1750_read_command = 0x20; // Measurement at 1 lx resolution.
static zh_bh1750_stats_t _stats = {0};

static esp_err_t _zh_bh1750_validate_config(const zh_bh1750_init_config_t *config);
static esp_err_t _zh_bh1750_i2c_init(const zh_bh1750_init_config_t *config, zh_bh1750_handle_t *handle);

esp_err_t zh_bh1750_init(const zh_bh1750_init_config_t *config, zh_bh1750_handle_t *handle)
{
    ZH_LOGI("BH1750 initialization begin.");
    ZH_ERROR_CHECK(config != NULL && handle != NULL, ESP_ERR_INVALID_ARG, NULL, "BH1750 initialization failed. Invalid argument.");
    ZH_ERROR_CHECK(_zh_bh1750_validate_config(config) == ESP_OK, ESP_FAIL, NULL, "BH1750 initialization failed. Initial configuration check failed.");
    ZH_ERROR_CHECK(_zh_bh1750_i2c_init(config, handle) == ESP_OK, ESP_FAIL, NULL, "BH1750 initialization failed. Failed to add I2C device.");
    handle->is_initialized = true;
    ZH_LOGI("BH1750 initialization completed successfully.");
    return ESP_OK;
}

esp_err_t zh_bh1750_deinit(zh_bh1750_handle_t *handle)
{
    ZH_LOGI("BH1750 deinitialization started.");
    ZH_ERROR_CHECK(handle != NULL, ESP_ERR_INVALID_ARG, NULL, "BH1750 deinitialization failed. Invalid argument.");
    ZH_ERROR_CHECK(handle->is_initialized == true, ESP_ERR_INVALID_STATE, NULL, "BH1750 deinitialization failed. BH1750 not initialized.");
    ZH_ERROR_CHECK(i2c_master_bus_rm_device(handle->dev_handle) == ESP_OK, ESP_FAIL, NULL, "BH1750 deinitialization failed. I2C remove device failed.");
    handle->is_initialized = false;
    ZH_LOGI("BH1750 deinitialization completed successfully.");
    return ESP_OK;
}

esp_err_t zh_bh1750_read(zh_bh1750_handle_t *handle, float *data) // -V2008
{
    ZH_LOGI("BH1750 read begin.");
    ZH_ERROR_CHECK(data != NULL && handle != NULL, ESP_ERR_INVALID_ARG, NULL, "BH1750 read fail. Invalid argument.");
    ZH_ERROR_CHECK(handle->is_initialized == true, ESP_ERR_NOT_FOUND, NULL, "BH1750 read fail. BH1750 not initialized.");
    uint8_t sensor_data[2] = {0};
    ZH_ERROR_CHECK(i2c_master_transmit(handle->dev_handle, &_bh1750_read_command, sizeof(_bh1750_read_command), 1000 / portTICK_PERIOD_MS) == ESP_OK, ESP_FAIL,
                   ++_stats.i2c_driver_error, "BH1750 read fail. I2C driver error.");
    vTaskDelay(180 / portTICK_PERIOD_MS);
    ZH_ERROR_CHECK(i2c_master_receive(handle->dev_handle, sensor_data, sizeof(sensor_data), 1000 / portTICK_PERIOD_MS) == ESP_OK, ESP_FAIL,
                   ++_stats.i2c_driver_error, "BH1750 read fail. I2C driver error.");
    *data = (sensor_data[0] << 8 | sensor_data[1]) / 1.2;
    ZH_LOGI("BH1750read completed successfully.");
    return ESP_OK;
}

const zh_bh1750_stats_t *zh_bh1750_get_stats(void)
{
    return &_stats;
}

void zh_bh1750_reset_stats(void)
{
    ZH_LOGI("Error statistic reset started.");
    _stats.i2c_driver_error = 0;
    ZH_LOGI("Error statistic reset successfully.");
}

static esp_err_t _zh_bh1750_validate_config(const zh_bh1750_init_config_t *config)
{
    ZH_ERROR_CHECK(config->i2c_address == 0x23 || config->i2c_address == 0x5C, ESP_ERR_INVALID_ARG, NULL, "Invalid I2C address.");
    ZH_ERROR_CHECK(config->i2c_frequency <= 400000, ESP_ERR_INVALID_ARG, NULL, "Invalid I2C frequency.");
    ZH_ERROR_CHECK(config->i2c_handle != NULL, ESP_ERR_INVALID_ARG, NULL, "Invalid I2C handle.");
    return ESP_OK;
}

static esp_err_t _zh_bh1750_i2c_init(const zh_bh1750_init_config_t *config, zh_bh1750_handle_t *handle)
{
    i2c_device_config_t bh1750_config = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = config->i2c_address,
        .scl_speed_hz = config->i2c_frequency,
    };
    i2c_master_dev_handle_t _dev_handle = NULL;
    ZH_ERROR_CHECK(i2c_master_bus_add_device(config->i2c_handle, &bh1750_config, &_dev_handle) == ESP_OK, ESP_FAIL, NULL, "Add I2C device failed.");
    ZH_ERROR_CHECK(i2c_master_probe(config->i2c_handle, config->i2c_address, 1000 / portTICK_PERIOD_MS) == ESP_OK, ESP_ERR_NOT_FOUND,
                   ZH_ERROR_CHECK(i2c_master_bus_rm_device(_dev_handle) == ESP_OK, ESP_FAIL, NULL, "I2C remove device failed."), "Sensor not connected or not responded.");
    handle->dev_handle = _dev_handle;
    return ESP_OK;
}
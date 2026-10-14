#include "driver/ledc.h"
#include "driver/gpio.h"
#include "zh_bh1750.h"
#include "driver/gpio.h"
#include "DHT22.h"
#include "confi.h"
#include "sr522.h"
#define I2C_PORT (I2C_NUM_MAX - 1)
zh_bh1750_handle_t bh1750_handle = {0};
sensor_data_t s_sensor_data;
equipment_status_t s_equipment_status;
sr522_config_t sr522_config = {
    .gpio = GPIO_SR522, // GPIO4
};
void hardware_init(void)
{
	/* GPIO relay */
	gpio_config_t io_conf = {
		.pin_bit_mask = (1ULL << RELAY1_GPIO) | (1ULL << RELAY2_GPIO),
		.mode = GPIO_MODE_OUTPUT,
		.pull_up_en = GPIO_PULLUP_DISABLE,
		.pull_down_en = GPIO_PULLDOWN_DISABLE,
		.intr_type = GPIO_INTR_DISABLE,
	};
	gpio_config(&io_conf);

	/* LEDC PWM */
	gpio_set_level(IN1_GPIO, 1);
	gpio_set_level(IN2_GPIO, 0);
	gpio_config_t io_confic = {
		.mode = GPIO_MODE_OUTPUT,
		.pin_bit_mask = (1ULL << IN1_GPIO) | (1ULL << IN2_GPIO),
		.pull_up_en = GPIO_PULLUP_DISABLE,
		.pull_down_en = GPIO_PULLDOWN_DISABLE,
		.intr_type = GPIO_INTR_DISABLE,
	};
	gpio_config(&io_confic);
	ledc_timer_config_t timer_conf = {
		.speed_mode = PWM_MODE,
		.timer_num = PWM_TIMER,
		.duty_resolution =PWM_DUTY_RES,
		.freq_hz = PWM_FREQ_HZ,
		.clk_cfg = LEDC_AUTO_CLK,
	};
	ledc_timer_config(&timer_conf);

	ledc_channel_config_t channel_conf = {
		.gpio_num = FAN_PWM_GPIO,
		.speed_mode = PWM_MODE,
		.channel = PWM_CHANNEL,
		.timer_sel = PWM_TIMER,
		.duty = 0,
		.hpoint = 0,
	};
	ledc_channel_config(&channel_conf);
}
void bh_1750_init(void){
        esp_log_level_set("zh_bh1750", ESP_LOG_ERROR);
    i2c_master_bus_config_t i2c_bus_config = {
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .i2c_port = I2C_PORT,
        .scl_io_num = SCL_GPIO ,
        .sda_io_num = SDA_GPIO ,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    i2c_master_bus_handle_t i2c_bus_handle;
    i2c_new_master_bus(&i2c_bus_config, &i2c_bus_handle);
    zh_bh1750_init_config_t config = ZH_BH1750_INIT_CONFIG_DEFAULT();
    config.i2c_handle = i2c_bus_handle;
    zh_bh1750_init(&config, &bh1750_handle);
}
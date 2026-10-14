#pragma once
#include "driver/gpio.h"
#include "driver/ledc.h"
#include "sr522.h"
#include "zh_bh1750.h"
// DHT22
#define DHT_GPIO          14
#define DHT_OK 0
#define DHT_CHECKSUM_ERROR -1
#define DHT_TIMEOUT_ERROR -2
// LED_ FAN GPIO
#define RELAY1_GPIO        GPIO_NUM_25          // led
#define RELAY2_GPIO        GPIO_NUM_26            // fan
// I2C for BH1750
#define SDA_GPIO   			GPIO_NUM_21
#define SCL_GPIO   			GPIO_NUM_22

// PWM for Motor
#define FAN_PWM_GPIO           GPIO_NUM_27
#define IN1_GPIO   			GPIO_NUM_18
#define IN2_GPIO   			GPIO_NUM_19

#define PWM_TIMER          LEDC_TIMER_0
#define PWM_MODE           LEDC_LOW_SPEED_MODE
#define PWM_CHANNEL        LEDC_CHANNEL_0
#define LEDC_MODE          PWM_MODE
#define LEDC_CHANNEL       PWM_CHANNEL
#define PWM_DUTY_RES    LEDC_TIMER_8_BIT   // 0-255
#define PWM_FREQ_HZ        5000

// SR522
#define GPIO_SR522          GPIO_NUM_4
extern sr522_config_t sr522_config;

// =====Struct save sensor data=====
typedef struct {
    float temperature;
    float humidity;
    float lux;
    bool motion_detected;
} sensor_data_t;
extern sensor_data_t s_sensor_data;
extern zh_bh1750_handle_t bh1750_handle;

void hardware_init(void);
void bh_1750_init(void);

// =====Struct sace status of quipment=====
typedef struct {
    bool led_state;
    bool fan_state;
    int fan_speed;
    bool led_auto_mode;  // true = Auto (motion sensor), false = Manual (dashboard)
} equipment_status_t;
extern equipment_status_t s_equipment_status;